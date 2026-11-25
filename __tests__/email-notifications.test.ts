import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import type { Transporter } from "nodemailer";
import { StrKey } from "@stellar/stellar-sdk";
import {
  confirmEmailSubscription,
  getEmailSubscriptionsForContract,
  initSchema,
  insertEvent,
  setDb,
  upsertEmailSubscription,
} from "../src/indexer/db.js";
import {
  resetMailTransportForTests,
  setMailTransportForTests,
} from "../src/utils/mailer.js";
import {
  resetEmailRateLimitBuckets,
} from "../src/middleware/email-rate-limit.js";
import {
  deliverEmailNotifications,
  resetEmailDeliveryQueueForTests,
  emailUnsubscribeUrl,
} from "../src/indexer/email-delivery.js";
import {
  EMAIL_NOTIFICATION_TYPES,
  notificationTypeFor,
  renderConfirmationEmail,
  renderEventEmail,
} from "../src/utils/email-templates.js";

const { default: notificationRoutes, unsubscribeRouter } = await import(
  "../src/routes/notifications.js"
);

const CONTRACT_A = StrKey.encodeContract(Buffer.alloc(32, 1));
const CONTRACT_B = StrKey.encodeContract(Buffer.alloc(32, 2));

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

let testDb: Database.Database;
let app: express.Express;
const sent: SentMessage[] = [];

function installTransport(): void {
  sent.length = 0;
  const fake = {
    sendMail: jest.fn(async (message: SentMessage) => {
      sent.push(message);
      return { messageId: "test" };
    }),
  };
  resetMailTransportForTests();
  setMailTransportForTests(fake as unknown as Transporter);
}

/** Event emails only — excludes the confirmation email. */
function eventEmails(): SentMessage[] {
  return sent.filter((m) => !m.subject.includes("Confirm"));
}

beforeAll(() => {
  testDb = new Database(":memory:");
  setDb(testDb);
  initSchema();

  app = express();
  app.use(express.json());
  app.use("/api/notifications", notificationRoutes);
  app.use(unsubscribeRouter);
});

afterAll(() => {
  testDb.close();
  resetMailTransportForTests();
  delete process.env.SMTP_URL;
  delete process.env.EMAIL_FROM;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.EMAIL_PER_IP_RATE_MAX;
  delete process.env.EMAIL_PER_ADDRESS_RATE_MAX;
  delete process.env.EMAIL_MAX_ACTIVE_PER_ADDRESS;
});

beforeEach(() => {
  process.env.SMTP_URL = "smtp://localhost:2525";
  process.env.EMAIL_FROM = "notifications@example.com";
  process.env.PUBLIC_BASE_URL = "https://escrow.test";
  delete process.env.EMAIL_PER_IP_RATE_MAX;
  delete process.env.EMAIL_PER_ADDRESS_RATE_MAX;
  delete process.env.EMAIL_MAX_ACTIVE_PER_ADDRESS;

  resetEmailRateLimitBuckets();
  resetEmailDeliveryQueueForTests();
  installTransport();

  testDb.exec("DELETE FROM email_subscriptions");
  testDb.exec("DELETE FROM events");
});

describe("email templates", () => {
  it("renders a plain-text and HTML body per notification type", () => {
    for (const type of EMAIL_NOTIFICATION_TYPES) {
      const unsubscribeUrl = emailUnsubscribeUrl(`token-${type}`);
      const rendered = renderEventEmail({
        notificationType: type,
        contractId: CONTRACT_A,
        eventType: type,
        ledger: 123,
        milestoneIndex: 1,
        unsubscribeUrl,
      });
      expect(rendered.subject).toContain("Escrow");
      expect(rendered.text).toContain(CONTRACT_A);
      expect(rendered.text).toContain(unsubscribeUrl);
      expect(rendered.html).toContain("href=");
      expect(rendered.html).toContain(unsubscribeUrl);
    }
  });

  it("renders the confirmation email with confirm and unsubscribe links", () => {
    const rendered = renderConfirmationEmail({
      contractId: CONTRACT_A,
      confirmUrl: "https://escrow.test/api/notifications/email/confirm?token=c",
      unsubscribeUrl: "https://escrow.test/unsubscribe?token=u",
    });
    expect(rendered.text).toContain("confirm?token=c");
    expect(rendered.text).toContain("unsubscribe?token=u");
    expect(rendered.html).toContain("Confirm notifications");
  });

  it("maps indexed event types to notification types", () => {
    expect(notificationTypeFor("deliver")).toBe("delivered");
    expect(notificationTypeFor("approved")).toBe("approved");
    expect(notificationTypeFor("dispute")).toBe("disputed");
    expect(notificationTypeFor("fund")).toBeNull();
  });
});

describe("POST /api/notifications/email", () => {
  it("creates a pending subscription and sends a confirmation email", async () => {
    const res = await request(app).post("/api/notifications/email").send({
      contract_id: CONTRACT_A,
      email: "Alice@Example.com",
      event_types: ["delivered"],
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.subscription.status).toBe("pending");
    expect(res.body.data.subscription.email).toBe("alice@example.com");

    const rows = getEmailSubscriptionsForContract(CONTRACT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].confirm_token).toHaveLength(64);
    expect(rows[0].unsubscribe_token).toHaveLength(64);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("alice@example.com");
    expect(sent[0].text).toContain(rows[0].confirm_token);
    expect(sent[0].text).toContain(rows[0].unsubscribe_token);
  });

  it("rejects an invalid email, contract id or event type", async () => {
    const badEmail = await request(app).post("/api/notifications/email").send({
      contract_id: CONTRACT_A,
      email: "not-an-email",
      event_types: ["delivered"],
    });
    expect(badEmail.status).toBe(400);

    const badContract = await request(app).post("/api/notifications/email").send({
      contract_id: "GABC",
      email: "a@example.com",
      event_types: ["delivered"],
    });
    expect(badContract.status).toBe(400);

    const badType = await request(app).post("/api/notifications/email").send({
      contract_id: CONTRACT_A,
      email: "a@example.com",
      event_types: ["nope"],
    });
    expect(badType.status).toBe(400);
  });

  it("enforces the per-email-address rate limit", async () => {
    process.env.EMAIL_PER_ADDRESS_RATE_MAX = "2";
    const payload = {
      contract_id: CONTRACT_A,
      email: "spam@example.com",
      event_types: ["delivered"],
    };

    expect((await request(app).post("/api/notifications/email").send(payload)).status).toBe(200);
    expect((await request(app).post("/api/notifications/email").send(payload)).status).toBe(200);
    expect((await request(app).post("/api/notifications/email").send(payload)).status).toBe(429);
  });

  it("enforces the per-IP rate limit across distinct addresses", async () => {
    process.env.EMAIL_PER_IP_RATE_MAX = "2";
    process.env.EMAIL_PER_ADDRESS_RATE_MAX = "10";

    for (const email of ["a@example.com", "b@example.com"]) {
      const res = await request(app).post("/api/notifications/email").send({
        contract_id: CONTRACT_A,
        email,
        event_types: ["delivered"],
      });
      expect(res.status).toBe(200);
    }

    const third = await request(app).post("/api/notifications/email").send({
      contract_id: CONTRACT_A,
      email: "c@example.com",
      event_types: ["delivered"],
    });
    expect(third.status).toBe(429);
  });

  it("caps active/pending subscriptions per address but allows re-subscribing", async () => {
    process.env.EMAIL_MAX_ACTIVE_PER_ADDRESS = "1";
    process.env.EMAIL_PER_ADDRESS_RATE_MAX = "10";

    const first = await request(app).post("/api/notifications/email").send({
      contract_id: CONTRACT_A,
      email: "cap@example.com",
      event_types: ["delivered"],
    });
    expect(first.status).toBe(200);

    const second = await request(app).post("/api/notifications/email").send({
      contract_id: CONTRACT_B,
      email: "cap@example.com",
      event_types: ["delivered"],
    });
    expect(second.status).toBe(429);

    // Re-subscribing the same (contract, email) pair resets that row instead
    // of adding a new one, so it stays within the cap.
    const resub = await request(app).post("/api/notifications/email").send({
      contract_id: CONTRACT_A,
      email: "cap@example.com",
      event_types: ["delivered", "approved"],
    });
    expect(resub.status).toBe(200);
  });

  it("returns 503 when SMTP_URL is unset", async () => {
    delete process.env.SMTP_URL;

    const res = await request(app).post("/api/notifications/email").send({
      contract_id: CONTRACT_A,
      email: "a@example.com",
      event_types: ["delivered"],
    });
    expect(res.status).toBe(503);
    expect(sent).toHaveLength(0);
  });
});

describe("confirmation and unsubscribe", () => {
  async function subscribe(email = "user@example.com"): Promise<{
    confirmToken: string;
    unsubscribeToken: string;
  }> {
    const res = await request(app).post("/api/notifications/email").send({
      contract_id: CONTRACT_A,
      email,
      event_types: ["delivered"],
    });
    expect(res.status).toBe(200);
    const row = getEmailSubscriptionsForContract(CONTRACT_A)[0];
    return {
      confirmToken: row.confirm_token,
      unsubscribeToken: row.unsubscribe_token,
    };
  }

  it("activates a pending subscription via the confirmation link", async () => {
    const { confirmToken } = await subscribe();

    const res = await request(app)
      .get("/api/notifications/email/confirm")
      .query({ token: confirmToken });

    expect(res.status).toBe(200);
    expect(getEmailSubscriptionsForContract(CONTRACT_A)[0].status).toBe("active");
  });

  it("rejects an unknown confirmation token", async () => {
    const res = await request(app)
      .get("/api/notifications/email/confirm")
      .query({ token: "deadbeef" });
    expect(res.status).toBe(400);
  });

  it("unsubscribes via GET /unsubscribe and stops further delivery", async () => {
    const { unsubscribeToken } = await subscribe();
    const row = getEmailSubscriptionsForContract(CONTRACT_A)[0];
    confirmEmailSubscription(row.confirm_token);

    insertEvent(CONTRACT_A, "deliver", 7000, 1, "{}");
    expect(await deliverEmailNotifications(7000, 7000)).toBe(1);

    const res = await request(app)
      .get("/unsubscribe")
      .query({ token: unsubscribeToken });
    expect(res.status).toBe(200);
    expect(getEmailSubscriptionsForContract(CONTRACT_A)[0].status).toBe("unsubscribed");

    insertEvent(CONTRACT_A, "deliver", 7001, 2, "{}");
    expect(await deliverEmailNotifications(7001, 7001)).toBe(0);
  });

  it("unsubscribes via POST /unsubscribe with a body token", async () => {
    const { unsubscribeToken } = await subscribe();
    const res = await request(app)
      .post("/unsubscribe")
      .send({ token: unsubscribeToken });
    expect(res.status).toBe(200);
    expect(getEmailSubscriptionsForContract(CONTRACT_A)[0].status).toBe("unsubscribed");
  });

  it("rejects an unknown unsubscribe token", async () => {
    const res = await request(app)
      .get("/unsubscribe")
      .query({ token: "nope" });
    expect(res.status).toBe(400);
  });
});

describe("event delivery", () => {
  it("sends no event email before the subscription is confirmed", async () => {
    await request(app).post("/api/notifications/email").send({
      contract_id: CONTRACT_A,
      email: "pending@example.com",
      event_types: ["delivered"],
    });

    insertEvent(CONTRACT_A, "deliver", 8000, 1, "{}");
    expect(await deliverEmailNotifications(8000, 8000)).toBe(0);
    expect(eventEmails()).toHaveLength(0);
  });

  it("delivers an event email once active, with the unsubscribe link", async () => {
    const row = upsertEmailSubscription({
      contractId: CONTRACT_A,
      email: "active@example.com",
      eventTypes: ["delivered"],
      confirmToken: "c".repeat(64),
      unsubscribeToken: "u".repeat(64),
    });
    confirmEmailSubscription(row.confirm_token);
    installTransport();

    insertEvent(CONTRACT_A, "deliver", 9000, 1, '{"milestone_index":3}');

    expect(await deliverEmailNotifications(9000, 9000)).toBe(1);
    const emails = eventEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain("Milestone delivered");
    expect(emails[0].text).toContain(`/unsubscribe?token=${"u".repeat(64)}`);
    expect(emails[0].html).toContain("/unsubscribe?token=");
  });

  it("only delivers event types the subscription asked for", async () => {
    const row = upsertEmailSubscription({
      contractId: CONTRACT_A,
      email: "approved-only@example.com",
      eventTypes: ["approved"],
      confirmToken: "c".repeat(64),
      unsubscribeToken: "u".repeat(64),
    });
    confirmEmailSubscription(row.confirm_token);
    installTransport();

    insertEvent(CONTRACT_A, "deliver", 9100, 1, "{}");
    insertEvent(CONTRACT_A, "approve", 9101, 2, "{}");

    expect(await deliverEmailNotifications(9100, 9101)).toBe(1);
    const emails = eventEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain("Milestone approved");
  });

  it("is a clean no-op when SMTP_URL is unset", async () => {
    const row = upsertEmailSubscription({
      contractId: CONTRACT_A,
      email: "off@example.com",
      eventTypes: ["delivered"],
      confirmToken: "c".repeat(64),
      unsubscribeToken: "u".repeat(64),
    });
    confirmEmailSubscription(row.confirm_token);
    installTransport();
    delete process.env.SMTP_URL;

    insertEvent(CONTRACT_A, "deliver", 9200, 1, "{}");
    expect(await deliverEmailNotifications(9200, 9200)).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

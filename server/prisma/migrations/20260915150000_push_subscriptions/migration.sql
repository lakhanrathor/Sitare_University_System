-- Browser push notifications.
--
-- Purely additive: nothing already stored changes, and with no VAPID keypair
-- configured the table simply stays empty while the bell and the live socket
-- carry on as before.
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- The push service's URL for one browser. Re-subscribing the same browser
-- returns the same endpoint, so this is what keeps a row per visit from
-- accumulating.
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- Prisma creates no FK index on PostgreSQL, and the cascade below fans out
-- from the user side on every account deletion.
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

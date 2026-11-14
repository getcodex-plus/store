-- NULL preserves automatic invitation-based levels for existing users.
ALTER TABLE "users" ADD COLUMN "referral_tier_id" TEXT;

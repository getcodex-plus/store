-- Serialize changes to a user's Passkeys and 2FA state via the users row.
-- This invariant also applies to SDK endpoints and concurrent requests.
CREATE OR REPLACE FUNCTION auth_passkey_owner_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM users WHERE id=COALESCE(NEW."userId",OLD."userId") FOR UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS auth_passkey_owner_lock ON auth_passkey;
CREATE TRIGGER auth_passkey_owner_lock BEFORE INSERT OR DELETE ON auth_passkey
FOR EACH ROW EXECUTE FUNCTION auth_passkey_owner_lock();

CREATE OR REPLACE FUNCTION auth_last_passkey_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM auth_passkey WHERE "userId"=OLD."userId") THEN
    DELETE FROM auth_verification WHERE value=OLD."userId" AND identifier LIKE '2fa-%';
    DELETE FROM auth_session WHERE "userId"=OLD."userId";
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS auth_last_passkey_removed ON auth_passkey;
CREATE TRIGGER auth_last_passkey_removed AFTER DELETE ON auth_passkey
FOR EACH ROW EXECUTE FUNCTION auth_last_passkey_removed();

DROP TRIGGER IF EXISTS auth_totp_requires_passkey ON users;
DROP FUNCTION IF EXISTS auth_totp_requires_passkey();

-- The SDK flag means MFA is required, not that a TOTP secret exists.
CREATE OR REPLACE FUNCTION auth_passkey_requires_mfa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM auth_passkey WHERE "userId"=NEW.id) THEN
    NEW.two_factor_enabled=true;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS auth_passkey_requires_mfa ON users;
CREATE TRIGGER auth_passkey_requires_mfa BEFORE UPDATE OF two_factor_enabled ON users
FOR EACH ROW EXECUTE FUNCTION auth_passkey_requires_mfa();

CREATE OR REPLACE FUNCTION auth_passkey_enable_mfa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE users SET two_factor_enabled=true WHERE id=NEW."userId";
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS auth_passkey_enable_mfa ON auth_passkey;
CREATE TRIGGER auth_passkey_enable_mfa AFTER INSERT ON auth_passkey
FOR EACH ROW EXECUTE FUNCTION auth_passkey_enable_mfa();

UPDATE users SET two_factor_enabled=true
WHERE NOT two_factor_enabled AND EXISTS(SELECT 1 FROM auth_passkey WHERE "userId"=users.id);
-- Recovery-code endpoints are disabled. Remove previously issued material.
UPDATE "twoFactor" SET "backupCodes"='' WHERE "backupCodes"<>'';

CREATE UNIQUE INDEX IF NOT EXISTS auth_one_opaque_account
  ON auth_account("userId") WHERE "providerId"='opaque';

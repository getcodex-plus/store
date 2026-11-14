ALTER TABLE orders
  ADD COLUMN refund_destination text,
  ADD COLUMN refund_status text,
  ADD COLUMN refund_automatic boolean NOT NULL DEFAULT false,
  ADD COLUMN refund_note text NOT NULL DEFAULT '',
  ADD COLUMN refund_actor text,
  ADD COLUMN refund_requested_at timestamptz,
  ADD COLUMN refund_completed_at timestamptz,
  ADD COLUMN refund_resolution_note text NOT NULL DEFAULT '',
  ADD COLUMN refund_resolved_by text,
  ADD CONSTRAINT orders_refund_destination_check
    CHECK (refund_destination IN ('wallet', 'original')),
  ADD CONSTRAINT orders_refund_status_check
    CHECK (refund_status IN ('processing', 'review', 'completed')),
  ADD CONSTRAINT orders_refund_record_check CHECK (
    (refund_status IS NULL AND refund_destination IS NULL AND NOT refund_automatic
      AND refund_requested_at IS NULL AND refund_completed_at IS NULL)
    OR
    (refund_status IS NOT NULL AND refund_destination IS NOT NULL
      AND refund_requested_at IS NOT NULL AND refund_actor IS NOT NULL
      AND kind = 'purchase'
      AND (NOT refund_automatic OR
        (refund_destination = 'original' AND provider = 'xorpay' AND external_amount > 0))
      AND (refund_destination <> 'original' OR refund_automatic OR length(trim(refund_note)) > 0)
      AND (
        (refund_status IN ('processing','review') AND status = 'failed'
          AND refund_automatic AND refund_completed_at IS NULL)
        OR
        (refund_status = 'completed' AND status = 'refunded' AND refund_completed_at IS NOT NULL)
      ))
  );

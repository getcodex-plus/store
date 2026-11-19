BEGIN;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refill_history jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE orders DROP CONSTRAINT orders_refund_record_check;
ALTER TABLE orders ADD CONSTRAINT orders_refund_record_check CHECK (
    (refund_status IS NULL AND refund_destination IS NULL AND NOT refund_automatic
        AND refund_requested_at IS NULL AND refund_completed_at IS NULL)
    OR (refund_status IS NOT NULL AND refund_destination IS NOT NULL AND refund_requested_at IS NOT NULL
        AND refund_actor IS NOT NULL AND kind = 'purchase'
        AND (NOT refund_automatic OR (refund_destination = 'original' AND provider = 'xorpay' AND external_amount > 0))
        AND (refund_destination <> 'original' OR refund_automatic OR length(trim(refund_note)) > 0)
        AND ((refund_status IN ('processing', 'review') AND status = 'failed'
              AND (refund_automatic OR (refund_status = 'review' AND refund_destination = 'original' AND external_amount > 0))
              AND refund_completed_at IS NULL)
             OR (refund_status = 'completed' AND status = 'refunded' AND refund_completed_at IS NOT NULL)))
);
COMMIT;

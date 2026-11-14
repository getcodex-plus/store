-- Lower the previous default schedule without overwriting custom rates.
-- Order snapshots and existing commissions keep their original amounts.
WITH candidates AS (
  SELECT id, COALESCE(NULLIF(body->'referralTiers', 'null'::jsonb), '[
    {"id":"starter","name":"邀请新星","minimumInvites":0,"rateBps":300},
    {"id":"sharer","name":"分享达人","minimumInvites":5,"rateBps":500},
    {"id":"ambassador","name":"推荐官","minimumInvites":20,"rateBps":700},
    {"id":"partner","name":"邀请合伙人","minimumInvites":50,"rateBps":900}
  ]'::jsonb) AS tiers
  FROM settings
  WHERE id = 1
), updated AS (
  SELECT id, (
    SELECT jsonb_agg(
      jsonb_set(tier, '{rateBps}', to_jsonb((position + 1) * 100))
      ORDER BY position
    )
    FROM jsonb_array_elements(tiers) WITH ORDINALITY AS entries(tier, position)
  ) AS tiers
  FROM candidates
  WHERE jsonb_path_query_array(tiers, '$[*].rateBps') = '[300,500,700,900]'::jsonb
    AND jsonb_array_length(tiers) = 4
)
UPDATE settings
SET body = body || jsonb_build_object('referralTiers', updated.tiers, 'rateBps', 200)
FROM updated
WHERE settings.id = updated.id;

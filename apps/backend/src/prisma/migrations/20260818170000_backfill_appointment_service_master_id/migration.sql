-- Backfill Appointment.services[].masterId from linked booking order notes.
-- Does not invent a second master: copies the (first) note master_id onto lines that lack one.

UPDATE appointments AS a
SET services = sub.new_services
FROM (
  SELECT
    a2.id,
    jsonb_agg(
      CASE
        WHEN NULLIF(elem.elem->>'masterId', '') IS NOT NULL THEN elem.elem
        ELSE elem.elem || jsonb_build_object('masterId', m.master_id)
      END
      ORDER BY elem.ord
    ) AS new_services
  FROM appointments a2
  JOIN LATERAL (
    SELECT (
      regexp_match(
        o.note,
        'master_id=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9]+)'
      )
    )[1] AS master_id
    FROM orders o
    WHERE o.kind = 'booking'
      AND o.note ILIKE '%appointmentId=' || a2.id::text || '%'
    LIMIT 1
  ) m ON m.master_id IS NOT NULL
  JOIN LATERAL jsonb_array_elements(a2.services) WITH ORDINALITY AS elem(elem, ord) ON true
  WHERE jsonb_typeof(a2.services) = 'array'
  GROUP BY a2.id
) sub
WHERE a.id = sub.id;

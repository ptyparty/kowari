create table partner (
  id serial primary key,
  name text not null,
  endpoint text not null,
  created_at timestamptz not null default now()
);
create table webhook_event (
  id bigserial primary key,
  partner_id int not null references partner(id),
  kind text not null,
  created_at timestamptz not null
);
create table webhook_attempt (
  id bigserial primary key,
  event_id bigint not null references webhook_event(id),
  attempt int not null,
  status int,
  error text,
  response jsonb,
  attempted_at timestamptz not null
);
create index on webhook_attempt (event_id);
insert into partner (name, endpoint) values
  ('Northwind Freight', 'https://hooks.northwind.example/shipments'),
  ('Blue Harbor Logistics', 'https://api.blueharbor.example/webhooks'),
  ('Cascade Carriers', 'https://cascade.example/events'),
  ('Meridian Parcel', 'https://meridian.example/hooks/v2'),
  ('Atlas Overland', 'https://atlas-overland.example/notify'),
  ('Pinecrest Shipping', 'https://pinecrest.example/webhook');
insert into webhook_event (partner_id, kind, created_at)
select 1 + (g % 6),
       (array['shipment.booked','shipment.picked_up','shipment.delivered','invoice.issued'])[1 + g % 4],
       now() - (g * interval '7 minutes')
from generate_series(1, 400) g;
insert into webhook_attempt (event_id, attempt, status, error, response, attempted_at)
select e.id, a,
       case when (e.partner_id = 3 and a < 4) or (e.partner_id = 5 and a < 2 and e.id % 4 = 0) then 503
            when e.partner_id = 2 and a = 1 and e.id % 5 = 0 then null
            else 200 end,
       case when e.partner_id = 2 and a = 1 and e.id % 5 = 0 then 'timeout after 10s' end,
       case
         when e.partner_id = 2 and a = 1 and e.id % 5 = 0 then null
         when (e.partner_id = 3 and a < 4) or (e.partner_id = 5 and a < 2 and e.id % 4 = 0) then jsonb_build_object(
           'status', 503,
           'headers', jsonb_build_object('retry-after', '120', 'x-request-id', md5(e.id::text || a::text)),
           'body', jsonb_build_object('error', 'upstream_unavailable', 'message', 'Shipment API is in maintenance until 02:00 UTC'))
         else jsonb_build_object(
           'status', 200,
           'headers', jsonb_build_object('x-request-id', md5(e.id::text || a::text)),
           'body', jsonb_build_object('received', true))
       end,
       e.created_at + (a * interval '30 seconds')
from webhook_event e,
     generate_series(1, case when e.partner_id = 3 then 4 when e.partner_id = 5 and e.id % 4 = 0 then 2 when e.partner_id = 2 and e.id % 5 = 0 then 2 else 1 end) a;

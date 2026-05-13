-- =============================================================================
-- C55 Tracker schema — single source of truth replacing the Excel workbook.
-- =============================================================================
-- Conventions
--   • All time values are stored in UTC.
--   • Active runtime is measured in *minutes* (matches the Excel tracker).
--   • Pressures (P01) are stored in kpsi to match the VantagePoint trace.
--
-- Layering
--   1. Catalog tables  : immutable taxonomy (equipment, part_catalog, slots).
--   2. Lifecycle table : a single serial-number's tenure in a slot.
--   3. Telemetry tables: raw samples + 10-min rolled windows + maintenance log.
--   4. Helper views    : structural odometer, consumable health, dashboard feed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. CATALOG
-- -----------------------------------------------------------------------------

create table if not exists public.equipment (
    equipment_id   text primary key,            -- '0091' | '0938' | '0198'
    display_name   text not null,
    line           text,                        -- production line / building
    commissioned_at timestamptz default now()
);

-- Canonical part list (sourced from the Excel "Data Validation" tab so part
-- names round-trip 1:1 between this DB and the legacy workbook export).
create table if not exists public.part_catalog (
    part_code                  text primary key,           -- 'HVB','HPT','PB',...
    display_name               text not null,              -- 'High Pressure Tee'
    category                   text not null
        check (category in ('homogenizer','cluster','pump','manifold',
                            'consumable','structural','instrument')),
    is_consumable              boolean not null default false,
    is_structural              boolean not null default false,
    expected_mtbf_minutes      integer,                    -- target life
    inspection_threshold_min   integer,                    -- HP Tee = 2000
    failure_threshold_min      integer,                    -- HP Tee = 2400
    seal_life_low_min          integer,                    -- 800 for seals
    seal_life_high_min         integer,                    -- 1200 for seals
    notes                      text
);

-- A *slot* is a fixed physical position on the machine. Slots never move;
-- the parts that occupy them rotate. The installation_id encodes
-- {equipment}_{zone+orientation+index} (e.g. '0091_LC2' = left cluster pos 2).
create table if not exists public.installation_slot (
    installation_id text primary key,
    equipment_id    text not null references public.equipment,
    part_code       text not null references public.part_catalog,
    zone            text not null
        check (zone in ('cluster','pump','homogenizer','manifold','instrument')),
    orientation     text
        check (orientation in ('left','middle','right','center')),
    slot_index      smallint,                              -- 1..5 for clusters
    sequence_order  smallint not null                      -- 1..N along the
                                                          -- production flow
);

-- -----------------------------------------------------------------------------
-- 2. LIFECYCLE — one row per serial-number tenure
-- -----------------------------------------------------------------------------

create table if not exists public.part_lifecycle (
    id                          uuid primary key default gen_random_uuid(),
    installation_id             text not null references public.installation_slot,
    serial_number               text not null,
    is_refurb                   boolean default false,
    installation_date           timestamptz not null,
    removal_date                timestamptz,               -- null while active
    failure_mode                text
        check (failure_mode in (
            'normal wear','scratches','binding (threads)',
            'fracture (port)','fracture (body)',
            'weephole leak','thread fracture','internal erosion','thermal drift',
            'other','unknown'
        )),
    failure_notes               text,
    -- Cached metrics, refreshed by the pipeline (cheap to recompute, costly
    -- to recalculate on every dashboard load).
    active_runtime_minutes      integer not null default 0,
    high_stress_minutes         integer not null default 0,
    cumulative_pressure_stress  numeric not null default 0,  -- ∫(P01-19) dt
    inferred_failures           integer not null default 0,
    last_metrics_refresh        timestamptz,
    archived_at                 timestamptz,                 -- "Replace Part"
    archive_reason              text,
    constraint lifecycle_window_unique
        unique (installation_id, installation_date)
);

create index if not exists part_lifecycle_active_idx
    on public.part_lifecycle (installation_id)
    where removal_date is null and archived_at is null;

-- -----------------------------------------------------------------------------
-- 3. TELEMETRY
-- -----------------------------------------------------------------------------

-- Raw 1-minute samples for the supported trends. We store the signal name
-- rather than wide columns so adding an Nth trend is a config change.
--
-- Canonical signal taxonomy (the soft check below documents it but stays
-- permissive so unknown signals are dropped, not rejected):
--
--   P01   Homogenizing pressure (transducer at outlet manifold), kpsi
--   P02   Applied gas pressure at homogenizing body valve, kpsi
--   T01   Seal-flush temperature, left   (downstream of pump body)
--   T02   Seal-flush temperature, middle (downstream of pump body)
--   T03   Seal-flush temperature, right  (downstream of pump body)
--   T04   Product loop temperature, pre-heat-exchanger
--   T05   Product loop temperature, post-heat-exchanger
--   FLOW  Product flow rate (lpm | gpm — store native, normalise downstream)
--   RPM   Motor / drive speed
--   VIB   Vibration (g-rms or ips)
create table if not exists public.sensor_sample (
    ts            timestamptz not null,
    equipment_id  text not null references public.equipment,
    signal        text not null,                            -- see taxonomy above
    value_kpsi    numeric,                                  -- pressure trends
    value_other   numeric,                                  -- temp / flow / etc
    primary key (equipment_id, signal, ts),
    constraint sensor_sample_signal_known check (
        signal in ('P01','P02','T01','T02','T03','T04','T05','FLOW','RPM','VIB')
    )
);

-- 10-minute rolling windows: pre-computed by the pipeline so the dashboard
-- never has to do heavy math in the browser.
create table if not exists public.sensor_window_10m (
    window_start  timestamptz not null,
    equipment_id  text not null references public.equipment,
    signal        text not null,
    sample_count  integer not null,
    mean_value    numeric,
    stdev_value   numeric,
    min_value     numeric,
    max_value     numeric,
    -- Logic Doc tags: 'off' = data gap; 'below_active' = below 19 kpsi;
    -- 'active' = 19..26 kpsi & stdev <= 2; 'high_stress' = stdev > 2 kpsi.
    status        text not null
        check (status in ('off','below_active','active','high_stress','out_of_band')),
    primary key (equipment_id, signal, window_start)
);

-- Maintenance / event log: replacements, inspections, off-windows, alerts.
create table if not exists public.maintenance_event (
    id              uuid primary key default gen_random_uuid(),
    equipment_id    text references public.equipment,
    installation_id text references public.installation_slot,
    lifecycle_id    uuid references public.part_lifecycle,
    event_type      text not null
        check (event_type in (
            'replace','inspect','clean','reset',
            'off_maintenance','high_stress_window',
            'inspection_alert','failure_alert',
            -- "failure_observation": operator-logged failure WITHOUT archiving
            -- the lifecycle (part is staying installed, e.g. minor scratches).
            'failure_observation',
            -- emitted by the run-validation engine when the biweekly pass
            -- cadence (10 or 6 passes per run) is violated.
            'data_integrity_alert',
            -- emitted per detected pass for traceability (the rollups live in
            -- pass_event / production_run; this is just an audit breadcrumb).
            'pass_detected'
        )),
    failure_mode    text,
    detected_at     timestamptz not null,
    ended_at        timestamptz,
    duration_minutes integer,
    source          text,                                   -- 'manual'|'csv-watch'
    notes           text,
    created_at      timestamptz default now()
);

create index if not exists maint_event_lifecycle_idx
    on public.maintenance_event (lifecycle_id, detected_at desc);

-- CSV ingest provenance — never re-process the same drop twice.
create table if not exists public.csv_ingest_log (
    id              uuid primary key default gen_random_uuid(),
    file_name       text not null,
    file_sha256     text not null unique,
    rows_ingested   integer not null,
    first_ts        timestamptz,
    last_ts         timestamptz,
    ingested_at     timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- 3b. PRODUCTION RUNS & PASS EVENTS
--
-- A "pass" is a contiguous P01 excursion into the active band (19..26 kpsi)
-- lasting ~36..40 minutes. Multiple passes (typically 6 or 10) make up a
-- production "run" — the operations cadence is 6 out of 7 runs = 10-pass and
-- 1 out of 7 = 6-pass over a rolling 14-day window.
-- -----------------------------------------------------------------------------

create table if not exists public.production_run (
    id                    uuid primary key default gen_random_uuid(),
    equipment_id          text not null references public.equipment,
    started_at            timestamptz not null,
    ended_at              timestamptz not null,
    expected_pass_count   integer,                          -- 10 or 6
    actual_pass_count     integer not null,
    status                text not null
        check (status in ('conforming','short','long','unknown_schedule')),
    notes                 text,
    created_at            timestamptz default now(),
    constraint production_run_unique unique (equipment_id, started_at)
);

create index if not exists production_run_eq_started_idx
    on public.production_run (equipment_id, started_at desc);

create table if not exists public.pass_event (
    id              uuid primary key default gen_random_uuid(),
    run_id          uuid references public.production_run on delete cascade,
    equipment_id    text not null references public.equipment,
    pass_index      smallint not null,                      -- 1..N within run
    started_at      timestamptz not null,
    ended_at        timestamptz not null,
    duration_min    numeric not null,
    peak_p01_kpsi   numeric,
    avg_p01_kpsi    numeric,
    status          text not null
        check (status in ('valid','short','long')),
    created_at      timestamptz default now(),
    constraint pass_event_unique unique (equipment_id, started_at)
);

create index if not exists pass_event_run_idx
    on public.pass_event (run_id, pass_index);

-- -----------------------------------------------------------------------------
-- 4. VIEWS — read models for the dashboard
-- -----------------------------------------------------------------------------

create or replace view public.v_active_lifecycle as
    select
        pl.id,
        pl.installation_id,
        s.equipment_id,
        s.zone,
        s.orientation,
        s.sequence_order,
        pc.part_code,
        pc.display_name as part_name,
        pc.is_consumable,
        pc.is_structural,
        pl.serial_number,
        pl.installation_date,
        pl.active_runtime_minutes,
        pl.high_stress_minutes,
        pl.cumulative_pressure_stress,
        pl.inferred_failures,
        pc.expected_mtbf_minutes,
        pc.inspection_threshold_min,
        pc.failure_threshold_min,
        case
            when pc.failure_threshold_min is not null
                 and pl.active_runtime_minutes >= pc.failure_threshold_min
                then 'critical'
            when pc.inspection_threshold_min is not null
                 and pl.active_runtime_minutes >= pc.inspection_threshold_min
                then 'watch'
            when pc.expected_mtbf_minutes is not null
                 and pl.active_runtime_minutes >= 0.85 * pc.expected_mtbf_minutes
                then 'critical'
            when pc.expected_mtbf_minutes is not null
                 and pl.active_runtime_minutes >= 0.60 * pc.expected_mtbf_minutes
                then 'watch'
            else 'nominal'
        end as health
    from public.part_lifecycle pl
    join public.installation_slot s using (installation_id)
    join public.part_catalog pc using (part_code)
    where pl.removal_date is null and pl.archived_at is null;

-- Structural-only odometer (HP Tees, Outlet Manifolds, Pump Bodies)
create or replace view public.v_structural_odometer as
    select * from public.v_active_lifecycle where is_structural;

-- Seal / consumable health curve
create or replace view public.v_consumable_health as
    select
        v.*,
        pc.seal_life_low_min,
        pc.seal_life_high_min,
        case
            when pc.seal_life_high_min is null then null
            when v.active_runtime_minutes >= pc.seal_life_high_min then 1.0
            when v.active_runtime_minutes <= pc.seal_life_low_min then
                v.active_runtime_minutes::numeric / nullif(pc.seal_life_low_min,0)
            else 0.5 + 0.5 * (
                (v.active_runtime_minutes - pc.seal_life_low_min)::numeric
                / nullif(pc.seal_life_high_min - pc.seal_life_low_min, 0)
            )
        end as wear_fraction
    from public.v_active_lifecycle v
    join public.part_catalog pc using (part_code)
    where pc.is_consumable;

-- =============================================================================
-- 5. RLS — public read for dashboard, service-role for writes.
-- =============================================================================

alter table public.equipment           enable row level security;
alter table public.part_catalog        enable row level security;
alter table public.installation_slot   enable row level security;
alter table public.part_lifecycle      enable row level security;
alter table public.sensor_sample       enable row level security;
alter table public.sensor_window_10m   enable row level security;
alter table public.maintenance_event   enable row level security;
alter table public.csv_ingest_log      enable row level security;
alter table public.production_run      enable row level security;
alter table public.pass_event          enable row level security;

do $$
declare t text;
begin
    foreach t in array array[
        'equipment','part_catalog','installation_slot','part_lifecycle',
        'sensor_sample','sensor_window_10m','maintenance_event','csv_ingest_log',
        'production_run','pass_event'
    ] loop
        execute format(
            'drop policy if exists "anon read %1$s" on public.%1$s;
             create policy "anon read %1$s" on public.%1$s
               for select to anon using (true);', t);
    end loop;
end$$;

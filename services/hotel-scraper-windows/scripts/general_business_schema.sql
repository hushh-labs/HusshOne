-- Approved additive schema in a separate business_directory database only.
CREATE TABLE public.businesses (
 id BIGSERIAL PRIMARY KEY,
 source TEXT NOT NULL,
 source_key TEXT NOT NULL,
 name TEXT NOT NULL CHECK (length(trim(name)) > 0),
 category TEXT NOT NULL CHECK (length(trim(category)) > 0),
 source_url TEXT NOT NULL,
 formatted_address TEXT,
 zip TEXT CHECK (zip ~ '^[0-9]{5}$'),
 state TEXT CHECK (state ~ '^[A-Z]{2}$'),
 lat DOUBLE PRECISION CHECK (lat BETWEEN -90 AND 90),
 lng DOUBLE PRECISION CHECK (lng BETWEEN -180 AND 180),
 phone TEXT,
 website TEXT,
 raw JSONB NOT NULL DEFAULT '{}'::jsonb,
 first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(source,source_key),
 CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE INDEX businesses_zip_idx ON public.businesses(zip);
CREATE INDEX businesses_category_idx ON public.businesses(category);

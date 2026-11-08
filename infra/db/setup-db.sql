-- Run as superuser, connected to the target database (orbit or orbit_test).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
GRANT ALL ON SCHEMA public TO orbit_migrator;
ALTER SCHEMA public OWNER TO orbit_migrator;
GRANT USAGE ON SCHEMA public TO orbit_app, orbit_admin;

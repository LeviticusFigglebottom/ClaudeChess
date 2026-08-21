-- Custom migration (authored, not generated): the citext extension backs the
-- case-insensitive unique handle column added in the next migration (A2.2).
CREATE EXTENSION IF NOT EXISTS citext;

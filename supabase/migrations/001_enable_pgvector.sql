-- Enable pgvector extension for embedding storage
-- This must run before any table that uses the vector type.
create extension if not exists vector;

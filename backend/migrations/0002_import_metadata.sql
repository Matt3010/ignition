alter table data_imports
  add column if not exists bbox text null,
  add column if not exists file_path text null,
  add column if not exists deactivated_count integer not null default 0;

create index if not exists data_imports_source_imported_idx on data_imports (source, imported_at desc);

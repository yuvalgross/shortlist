-- Private file buckets (Gate 0)
-- cv-uploads:  the user's original CVs. Path: <user_id>/<file>. User can upload, read and delete their own.
-- cv-outputs:  tailored CVs written by the worker. Path: <user_id>/<file>. User can read and delete their own.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('cv-uploads', 'cv-uploads', false, 5242880,
   array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  ('cv-outputs', 'cv-outputs', false, 10485760,
   array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png'])
on conflict (id) do nothing;

create policy cv_uploads_own_read on storage.objects for select to authenticated
  using (bucket_id = 'cv-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy cv_uploads_own_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'cv-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy cv_uploads_own_delete on storage.objects for delete to authenticated
  using (bucket_id = 'cv-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy cv_outputs_own_read on storage.objects for select to authenticated
  using (bucket_id = 'cv-outputs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy cv_outputs_own_delete on storage.objects for delete to authenticated
  using (bucket_id = 'cv-outputs' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Private Storage bucket for Memory Lane image and audio assets.
-- The server uses the service role; browser roles receive no Storage access.

insert into storage.buckets (id, name, public)
values ('memory-assets', 'memory-assets', false)
on conflict (id) do nothing;

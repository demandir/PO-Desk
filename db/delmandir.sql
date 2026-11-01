-- DelMandir departments. Safe to run more than once.
update public.departments set active = false where code = 'GEN';

insert into public.departments (name, code) values
  ('Facilities', 'FAC'),
  ('Service', 'SVC'),
  ('CAPA', 'CAPA'),
  ('Mahila', 'MAH'),
  ('Satsang', 'SAT'),
  ('Accounting', 'ACCT'),
  ('AV/IT', 'AVIT'),
  ('iBKY', 'IBKY')
on conflict (code) do nothing;

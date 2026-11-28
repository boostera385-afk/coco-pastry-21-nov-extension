-- The dashboard now shows one dialer at a time (Google Voice / Vici Dialer dropdown), each with its own data.
-- The agent scorecard measures Google Voice work (texts, missed calls, reply times), so it counts only Google Voice
-- issues again; Vici issues are shown on the Vici Dialer analysis view. Rewrites the live definition in place.
do $$
declare d text;
begin
  for d in select pg_get_functiondef(p.oid) from pg_proc p
            where p.proname = 'analysis_scorecard' and p.pronamespace = 'public'::regnamespace loop
    if d !~ 'analysis_issues_gv\(' then
      execute regexp_replace(d, '(^|[^_a-z])analysis_issues\(', '\1analysis_issues_gv(', 'g');
    end if;
  end loop;
end $$;

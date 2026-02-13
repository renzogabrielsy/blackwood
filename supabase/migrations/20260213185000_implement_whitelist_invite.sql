create table "public"."user_invites" (
    "email" text not null,
    "role" text not null default 'Employee'::text,
    "created_at" timestamp with time zone default now(),
    "invited_by" uuid
);


alter table "public"."user_invites" enable row level security;

CREATE UNIQUE INDEX user_invites_pkey ON public.user_invites USING btree (email);

alter table "public"."user_invites" add constraint "user_invites_pkey" PRIMARY KEY using index "user_invites_pkey";

alter table "public"."user_invites" add constraint "user_invites_invited_by_fkey" FOREIGN KEY (invited_by) REFERENCES profiles(id) ON DELETE SET NULL not valid;

alter table "public"."user_invites" validate constraint "user_invites_invited_by_fkey";

create policy "Admins can delete invites"
on "public"."user_invites"
as permissive
for delete
to authenticated
using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role = 'Owner'::text) OR (profiles.role = 'Admin'::text))))));


create policy "Admins can insert invites"
on "public"."user_invites"
as permissive
for insert
to authenticated
with check ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role = 'Owner'::text) OR (profiles.role = 'Admin'::text))))));


create policy "Admins can select invites"
on "public"."user_invites"
as permissive
for select
to authenticated
using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.role = 'Owner'::text) OR (profiles.role = 'Admin'::text))))));

-- Update handle_new_user to check the whitelist
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  invited_role text;
BEGIN
  -- Check if email is in user_invites
  SELECT role INTO invited_role
  FROM public.user_invites
  WHERE email = NEW.email;

  -- Insert profile
  INSERT INTO public.profiles (id, email, display_name, avatar_url, role, status)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', NEW.email),
    NEW.raw_user_meta_data->>'avatar_url',
    COALESCE(invited_role, 'Employee'), -- Default role if not invited (though status will likely be pending)
    CASE 
      WHEN invited_role Is NOT NULL THEN 'active'
      ELSE 'pending'
    END
  )
  ON CONFLICT (id) DO UPDATE SET
    display_name = COALESCE(EXCLUDED.display_name, profiles.display_name),
    avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
    -- If they were pending and now invited (re-signup case), allow update to active? 
    -- Actually this trigger only runs on INSERT to auth.users. 
    -- So this ON CONFLICT is mostly for robustness if profile pre-existed somehow.
    status = CASE 
      WHEN invited_role Is NOT NULL AND profiles.status = 'pending' THEN 'active'
      ELSE profiles.status
    END;

  RETURN NEW;
END;
$function$;

-- New Trigger: handle_invite_creation
-- If we invite someone who is already in the system as "pending", activate them.
CREATE OR REPLACE FUNCTION public.handle_invite_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE public.profiles
  SET 
    status = 'active',
    role = NEW.role
  WHERE email = NEW.email AND status = 'pending';
  
  RETURN NEW;
END;
$function$;

CREATE TRIGGER on_invite_created
  AFTER INSERT ON public.user_invites
  FOR EACH ROW EXECUTE FUNCTION public.handle_invite_creation();

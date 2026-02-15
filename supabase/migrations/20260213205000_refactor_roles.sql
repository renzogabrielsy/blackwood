-- Migration: Refactor Roles (Employee -> Production, Add Accounting)

BEGIN;

-- 1. Profiles: Drop existing check constraint to allow updates
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

-- 2. Update Data: Employee -> Production
-- We do this BEFORE adding the new constraint to ensure validity
UPDATE public.profiles SET role = 'Production' WHERE role = 'Employee';
UPDATE public.user_invites SET role = 'Production' WHERE role = 'Employee';

-- 3. Update Default Values
ALTER TABLE public.profiles ALTER COLUMN role SET DEFAULT 'Production';
ALTER TABLE public.user_invites ALTER COLUMN role SET DEFAULT 'Production';

-- 4. Profiles: Add new check constraint including 'Production' and 'Accounting'
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check 
CHECK (role IN ('Owner', 'Admin', 'Dev', 'Production', 'Accounting'));

-- 5. User Invites: Add check constraint
ALTER TABLE public.user_invites DROP CONSTRAINT IF EXISTS user_invites_role_check;
ALTER TABLE public.user_invites ADD CONSTRAINT user_invites_role_check 
CHECK (role IN ('Owner', 'Admin', 'Dev', 'Production', 'Accounting'));

-- 6. Update Trigger Function to use 'Production' as default
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
    COALESCE(invited_role, 'Production'), -- UPDATED: Employee -> Production
    CASE 
      WHEN invited_role Is NOT NULL THEN 'active'
      ELSE 'pending'
    END
  )
  ON CONFLICT (id) DO UPDATE SET
    display_name = COALESCE(EXCLUDED.display_name, profiles.display_name),
    avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
    status = CASE 
      WHEN invited_role Is NOT NULL AND profiles.status = 'pending' THEN 'active'
      ELSE profiles.status
    END;

  RETURN NEW;
END;
$function$;

COMMIT;

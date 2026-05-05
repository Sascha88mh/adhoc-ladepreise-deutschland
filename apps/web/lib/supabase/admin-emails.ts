function parseAdminEmails(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

const ADMIN_EMAILS = parseAdminEmails(process.env.ADMIN_EMAILS);

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  if (ADMIN_EMAILS.size === 0) return false;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

export function adminEmailsConfigured(): boolean {
  return ADMIN_EMAILS.size > 0;
}

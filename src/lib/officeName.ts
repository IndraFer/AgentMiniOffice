export const officeNameError = "office name must be one line of 1–32 characters";

/** Match the form's maxlength. Never truncate identity-bearing user input. */
export function officeDisplayName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= 32 && !/[\r\n\t]/.test(name) ? name : null;
}

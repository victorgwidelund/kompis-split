export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Reservmetod för HTTP och mobilwebbläsare. */ }
  }
  const input = document.createElement("textarea");
  input.value = text; input.readOnly = true; input.style.position = "fixed"; input.style.opacity = "0";
  document.body.append(input); input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
  const copied = document.execCommand("copy"); input.remove();
  if (!copied) throw new Error("Webbläsaren blockerade kopieringen");
}

export function swishPaymentUrl(phoneValue: string, amountCents: number, message: string): string {
  const phone = phoneValue.replace(/\D/g, "");
  if (!phone) return "";
  const data = { version: 1, payee: { value: phone, editable: false }, amount: { value: amountCents / 100, editable: false }, message: { value: message.slice(0, 50), editable: true } };
  return `swish://payment?data=${encodeURIComponent(JSON.stringify(data))}`;
}

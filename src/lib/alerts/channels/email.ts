/** Email relay via Resend (https://resend.com — generous free tier).
 *  Swap this one function for SendGrid/Postmark/SES if you prefer;
 *  nothing else in the app depends on the provider. */
export async function sendEmail(message: string, to: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERTS_EMAIL_FROM;
  if (!apiKey || !from || !to) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: "Leverage Terminal alert",
        text: message,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

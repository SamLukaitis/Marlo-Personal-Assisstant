import { useSearchParams } from "react-router-dom";
import "./home.css";

// Where the WhatsApp-native registration flow's OAuth round trip lands the browser (see
// server/src/routes/authRoutes.ts's "whatsapp_register" intent). Deliberately static and public
// — no auth, no data fetching — since the person completing this has no session yet and the
// real confirmation happens back on WhatsApp (server/src/services/whatsappRegistration.ts pushes
// it proactively the moment this page's OAuth callback succeeds).
const ERROR_COPY: Record<string, string> = {
  expired: "That link has expired or was already used. Go back to WhatsApp and ask for a new one.",
  not_invited: "That email isn't on the early-access list yet. Go back to WhatsApp and try a different address.",
  phone_taken: "This WhatsApp number is already connected to a different Marlo account.",
  account_exists:
    "That email already belongs to a Marlo account we can't confirm is yours. Sign in on the website the way you did before, then add this number from Settings.",
  oauth_failed: "Something went wrong connecting your account. Go back to WhatsApp and try again.",
};

export function ConnectedPage() {
  const [params] = useSearchParams();
  const error = params.get("error");

  return (
    <div className="home">
      <main>
        <div className="home-shell" style={{ maxWidth: 480, textAlign: "center", paddingTop: "18vh" }}>
          <span className="home-mark" style={{ display: "inline-flex", margin: "0 auto 20px" }}>
            M
          </span>
          {error ? (
            <>
              <h1 className="home-h2">That didn't work</h1>
              <p className="home-lede">{ERROR_COPY[error] ?? ERROR_COPY.oauth_failed}</p>
            </>
          ) : (
            <>
              <h1 className="home-h2">You're connected</h1>
              <p className="home-lede">Head back to WhatsApp — Marlo's already messaging you there.</p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

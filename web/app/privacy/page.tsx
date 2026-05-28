export const metadata = {
  title: "Privacy Policy",
  description: "Arcade Privacy Policy. Minimal data collection; no tracking; no third-party sale.",
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold sm:text-4xl">Privacy Policy</h1>
      <p className="mt-2 text-xs text-arc-text-faint">Last updated: 2026-05-29</p>

      <div className="mt-8 space-y-6 text-sm text-arc-text-muted">
        <Section title="1. Summary">
          <p>
            Arcade is a non-custodial, public-blockchain interface. We collect the minimum
            information necessary to operate the Service and never sell or rent your personal data
            to third parties.
          </p>
        </Section>

        <Section title="2. Data we collect">
          <p>
            <b className="text-arc-text">Wallet addresses.</b> When you connect a wallet, we read
            its public address. This is the only on-chain identifier we use. No personal data is
            derived from it.
          </p>
          <p className="mt-2">
            <b className="text-arc-text">Twitter @handle (OAuth).</b> If you initiate the Twitter
            claim flow, we read your public Twitter username via the official Twitter API to
            verify it matches the @handle attributed to a token slot. We do not access your
            tweets, direct messages, email, follower list, or any other Twitter data.
          </p>
          <p className="mt-2">
            <b className="text-arc-text">Server logs.</b> Our hosting provider (Vercel) records
            standard HTTP logs (timestamp, IP, requested URL, user agent) for up to 30 days. We
            use these to debug and prevent abuse. We do not enrich or sell these logs.
          </p>
          <p className="mt-2">
            <b className="text-arc-text">No cookies, no analytics, no fingerprinting.</b> We do
            not use Google Analytics, Facebook Pixel, or any third-party tracker. The only cookies
            we set are short-lived (10 min) HTTP-only cookies for the OAuth state nonce.
          </p>
        </Section>

        <Section title="3. How we use the data">
          <ul className="ml-5 list-disc space-y-1">
            <li>Wallet addresses are passed to smart contracts to execute the transactions you authorize</li>
            <li>Twitter @handle is compared with on-chain slot metadata to verify a claim; the comparison happens server-side and the result is signed via EIP-712</li>
            <li>Server logs are reviewed only in case of debugging or abuse investigation</li>
          </ul>
        </Section>

        <Section title="4. On-chain data is public">
          <p>
            All actions you take through the Service (token launches, swaps, recipient updates,
            comments, claims) are recorded on the Arc public blockchain. Once on-chain, this data
            is permanent and viewable by anyone via any block explorer. We have no ability to
            delete it.
          </p>
        </Section>

        <Section title="5. Third-party services">
          <p>
            We use the following third parties strictly for operational purposes:
          </p>
          <ul className="ml-5 mt-2 list-disc space-y-1">
            <li><b className="text-arc-text">Vercel</b> for hosting and serverless functions</li>
            <li><b className="text-arc-text">Twitter (X) Developer API</b> for OAuth verification when you initiate a Twitter claim</li>
            <li><b className="text-arc-text">Arc RPC providers</b> for reading and submitting transactions to the Arc blockchain</li>
            <li><b className="text-arc-text">WalletConnect</b> when you choose a WalletConnect-compatible wallet</li>
          </ul>
          <p className="mt-2">
            We do not sell, rent, or trade your data to any third party for marketing or
            advertising purposes.
          </p>
        </Section>

        <Section title="6. Your rights">
          <p>
            You may stop using the Service at any time by disconnecting your wallet. You can
            revoke the Arcade app&apos;s access to your Twitter account at any time via
            twitter.com/settings/connected_apps.
          </p>
          <p className="mt-2">
            For residents of jurisdictions with applicable data protection laws (e.g. GDPR in the
            EU, CCPA in California), you may request access to, correction of, or deletion of any
            non-public information we hold about you. Reach out via the contact methods linked
            in the footer.
          </p>
        </Section>

        <Section title="7. Children">
          <p>
            The Service is not directed to individuals under the age of majority in their
            jurisdiction. We do not knowingly collect data from minors.
          </p>
        </Section>

        <Section title="8. Security">
          <p>
            We follow industry-standard practices to protect server infrastructure and credentials.
            However, the Service is provided on an &quot;as is&quot; basis and no system is perfectly
            secure. You are responsible for keeping your wallet and Twitter credentials safe.
          </p>
        </Section>

        <Section title="9. Changes">
          <p>
            We may update this Privacy Policy from time to time. The &quot;Last updated&quot; date at the
            top reflects the current version. Significant changes will be communicated via the
            Service.
          </p>
        </Section>

        <Section title="10. Contact">
          <p>
            For privacy-related questions or requests, reach out via the community channels linked
            from the footer.
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-arc-text">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

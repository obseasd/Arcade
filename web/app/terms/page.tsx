export const metadata = {
  title: "Terms of Service",
  description: "Arcade Terms of Service. Testnet only.",
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold sm:text-4xl">Terms of Service</h1>
      <p className="mt-2 text-xs text-arc-text-faint">Last updated: 2026-05-29</p>

      <div className="mt-8 space-y-6 text-sm text-arc-text-muted">
        <Section title="1. Acceptance">
          <p>
            By accessing or using Arcade (the &quot;Service&quot;), available at arcade.trading and any
            subdomains, you (&quot;you&quot;, &quot;User&quot;) agree to be bound by these Terms of Service. If you
            do not agree, do not use the Service.
          </p>
        </Section>

        <Section title="2. Nature of the Service">
          <p>
            Arcade is an experimental decentralized application running on the Arc public blockchain
            (testnet). It exposes interfaces to interact with permissionless smart contracts that
            implement a token launchpad, an automated market maker, and ancillary primitives.
          </p>
          <p className="mt-2 font-semibold text-arc-warn">
            The Service is operated on testnet. Tokens have no monetary value. Nothing on the
            Service is financial advice, an offer to sell or solicitation to buy any security or
            financial product, or a recommendation to engage in any transaction.
          </p>
        </Section>

        <Section title="3. Eligibility">
          <p>
            You represent that you are of legal age in your jurisdiction and that your use of the
            Service is permitted by applicable law. You are responsible for complying with all
            laws, including securities, tax, and anti-money-laundering laws, in any jurisdiction
            you are subject to.
          </p>
          <p className="mt-2">
            You may not use the Service if you are located in or a resident of any jurisdiction
            where access is restricted by law, or if you are on any sanctions list maintained by
            OFAC or equivalent authorities.
          </p>
        </Section>

        <Section title="4. Wallets and custody">
          <p>
            Arcade is non-custodial. You connect a self-custodied wallet (MetaMask, Rabby, or a
            WalletConnect-compatible wallet). We do not control, hold, or access your private
            keys, seed phrase, or funds at any time. You are solely responsible for the security
            of your wallet.
          </p>
          <p className="mt-2">
            Twitter-attributed fee escrow positions are held by the on-chain `ArcadeTwitterEscrow`
            contract until claimed by a wallet whose owner has proved control of the attributed
            @handle via Twitter OAuth.
          </p>
        </Section>

        <Section title="5. Smart contract risk">
          <p>
            Smart contracts are immutable. Bugs, exploits, or unintended behavior may result in
            partial or total loss of any funds interacting with the contracts. Arcade is provided
            on an &quot;as is&quot; and &quot;as available&quot; basis. We make no representation or warranty,
            express or implied, regarding the contracts&apos; security, fitness for any purpose, or
            error-free operation.
          </p>
        </Section>

        <Section title="6. Twitter integration">
          <p>
            Arcade offers an optional Twitter OAuth flow to verify ownership of a @handle and
            claim fees attributed to it. By using this flow you authorize Arcade to read your
            public Twitter username via the official Twitter API. We never request write access
            or access to tweets you have not posted publicly. See our Privacy Policy for details.
          </p>
        </Section>

        <Section title="7. No fiduciary duty">
          <p>
            No relationship between Arcade and any user is fiduciary in nature. Arcade does not
            act as a broker, dealer, exchange, custodian, financial advisor, or money services
            business with respect to any user.
          </p>
        </Section>

        <Section title="8. Limitation of liability">
          <p>
            To the maximum extent permitted by applicable law, Arcade and its operators shall not
            be liable for any indirect, incidental, special, consequential, or punitive damages,
            or any loss of profits, data, use, or goodwill, arising out of or in connection with
            the Service.
          </p>
        </Section>

        <Section title="9. Changes to the Terms">
          <p>
            We may amend these Terms at any time by posting a revised version. The &quot;Last updated&quot;
            date at the top reflects the current version. Continued use of the Service after a
            change constitutes acceptance of the new Terms.
          </p>
        </Section>

        <Section title="10. Contact">
          <p>
            For questions about these Terms or the Service, reach out through GitHub Issues or the
            community channels linked from the footer.
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

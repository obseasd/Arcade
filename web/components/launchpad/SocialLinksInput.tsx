"use client";

import { SOCIAL_FIELDS, type SocialKey } from "@/lib/socials";

/** The 5-field social links section for the launch create form. Raw input only;
 *  validation/filtering happens at submit via buildSocialsForMetadata. */
export function SocialLinksInput({
    values,
    onChange,
}: {
    values: Partial<Record<SocialKey, string>>;
    onChange: (key: SocialKey, value: string) => void;
}) {
    return (
        <div className="space-y-3 rounded-xl border border-arc-border bg-arc-bg-elevated p-4">
            <span className="text-sm font-medium text-arc-text">Social links (optional)</span>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {SOCIAL_FIELDS.map((f) => (
                    <label key={f.key} className="block text-sm">
                        <span className="text-arc-text-muted">{f.label}</span>
                        <input
                            type="text"
                            value={values[f.key] ?? ""}
                            onChange={(e) => onChange(f.key, e.target.value)}
                            placeholder={f.placeholder}
                            className="mt-1 w-full rounded-lg border border-arc-border bg-arc-bg px-3 py-2 text-sm focus:border-arc-cta-hover focus:outline-none"
                        />
                    </label>
                ))}
            </div>
            <p className="text-xs text-arc-text-faint">
                You can use full URLs, usernames, or handles (e.g., @username). Invalid links will be
                filtered out.
            </p>
        </div>
    );
}

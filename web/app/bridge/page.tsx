import { BridgeContainer } from "@/components/bridge/BridgeContainer";

/**
 * Bridge page. EVM <-> Arc runs through the audited CCTP BridgeCard;
 * Solana <-> Arc runs through Circle App Kit. The network-family toggle
 * + history live in BridgeContainer.
 */
export default function BridgePage() {
  return <BridgeContainer />;
}

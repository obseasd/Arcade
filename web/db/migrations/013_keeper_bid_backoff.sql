-- Per-order re-bid failure counter. When the keeper holds a stale winning bid
-- whose fill keeps reverting despite the quote clearing the floor (a dstToken
-- that delivers less than getAmountsOut says, eg fee-on-transfer / returns-false),
-- re-bidding every staleness window is a gas drain + action-budget DoS. After a
-- few fails the keeper backs off this order. Reset to 0 on a successful fill.
-- Re-runnable.
ALTER TABLE keeper_orbs_orders
    ADD COLUMN IF NOT EXISTS bid_fail_count INT NOT NULL DEFAULT 0;

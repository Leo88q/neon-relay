//! Host unit tests, not validator/CPI tests. No network or private keys.
use anchor_lang::prelude::*;
use neonrelay_economy::{
    merkle_leaf_v2, reserve_prizes_v2, split_fee_v2, tier_fees_v2, verify_proof_v2,
    EconomyConfigV2, EntryTicketV2, PrizeClaimV2, PrizeEpochV2,
};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn mint_bound_leaf_golden_vectors() {
    assert_eq!(hex(&merkle_leaf_v2(&[7; 32], 50, &[9; 32])), "b69d2a3ed0a46bed90257a6cfcc2fcf804468ebaf2ab78e85c94b62610f6c3fc");
    assert_eq!(hex(&merkle_leaf_v2(&[7; 32], 50, &[10; 32])), "aa1c8390b3c75bc54d8d954e025e4f38ac5b6d2aa3bd3a178c7e176156121e6d");
    assert_eq!(hex(&merkle_leaf_v2(&[1; 32], u64::MAX, &[2; 32])), "be2551a62c6b373bd7b82a1dc3f2a874c79d83668eb08f100deba9f1f5905a0f");
}

#[test]
fn proof_cap_and_index_aliases() {
    let leaf = merkle_leaf_v2(&[7; 32], 50, &[9; 32]);
    assert!(verify_proof_v2(&leaf, 0, &[], &leaf));
    assert!(!verify_proof_v2(&leaf, 1, &[], &leaf));
    assert!(!verify_proof_v2(&leaf, 0, &[[0; 32]; 33], &leaf));
    assert!(!verify_proof_v2(&merkle_leaf_v2(&[7; 32], 50, &[10; 32]), 0, &[], &leaf));
    let proof = [[11; 32]; 32];
    let mut root = leaf;
    for sibling in &proof {
        root = anchor_lang::solana_program::hash::hashv(&[sibling, &root]).to_bytes();
    }
    assert!(verify_proof_v2(&leaf, u32::MAX, &proof, &root));
}

#[test]
fn fixed_tiers_use_mint_decimals_and_reject_overflow() {
    assert_eq!(tier_fees_v2(0).unwrap(), [50, 100, 500, 2000]);
    assert_eq!(tier_fees_v2(6).unwrap(), [50_000_000, 100_000_000, 500_000_000, 2_000_000_000]);
    assert_eq!(tier_fees_v2(9).unwrap()[3], 2_000_000_000_000);
    assert!(tier_fees_v2(16).is_err());
    assert!(tier_fees_v2(255).is_err());
}

#[test]
fn rake_conserves_even_maximum_u64_fee() {
    assert_eq!(split_fee_v2(50, 1000).unwrap(), (5, 45));
    assert_eq!(split_fee_v2(1, 1000).unwrap(), (0, 1));
    assert_eq!(split_fee_v2(50, 2000).unwrap(), (10, 40));
    assert_eq!(split_fee_v2(50, 0).unwrap(), (0, 50));
    let (rake, pool) = split_fee_v2(u64::MAX, 2000).unwrap();
    assert_eq!(rake.checked_add(pool).unwrap(), u64::MAX);
    assert!(split_fee_v2(50, 2001).is_err());
    assert!(split_fee_v2(0, 1000).is_err());
}

#[test]
fn epochs_cannot_overcommit_the_same_balance() {
    let reserved = reserve_prizes_v2(100, 0, 60).unwrap();
    assert_eq!(reserved, 60);
    assert!(reserve_prizes_v2(100, reserved, 50).is_err());
    assert_eq!(reserve_prizes_v2(100, reserved, 40).unwrap(), 100);
    assert!(reserve_prizes_v2(100, 101, 1).is_err());
    assert!(reserve_prizes_v2(100, 0, 0).is_err());
    assert_eq!(reserve_prizes_v2(u64::MAX, 0, u64::MAX).unwrap(), u64::MAX);
    // After a claim both vault balance and aggregate reservation decrease.
    assert_eq!(reserve_prizes_v2(80, 40, 40).unwrap(), 80);
}

#[test]
fn layouts_are_pinned_for_rpc_and_mobile_decoders() {
    assert_eq!(8 + EconomyConfigV2::INIT_SPACE, 180);
    assert_eq!(8 + EntryTicketV2::INIT_SPACE, 123);
    assert_eq!(8 + PrizeEpochV2::INIT_SPACE, 109);
    assert_eq!(8 + PrizeClaimV2::INIT_SPACE, 97);
}

#[test]
fn every_pda_family_is_mint_isolated() {
    let mint_a = [9u8; 32];
    let mint_b = [10u8; 32];
    let wallet = [7u8; 32];
    let reference = [4u8; 32];
    let epoch = 1u64.to_le_bytes();
    let program = neonrelay_economy::id();
    for (seed, extra) in [
        (b"neonrelay_economy_v2".as_slice(), vec![]),
        (b"neonrelay_entry_v2".as_slice(), vec![reference.as_slice(), wallet.as_slice()]),
        (b"neonrelay_prizes_v2".as_slice(), vec![epoch.as_slice()]),
        (b"neonrelay_claim_v2".as_slice(), vec![epoch.as_slice(), wallet.as_slice()]),
    ] {
        let mut a = vec![seed, mint_a.as_slice()]; a.extend(&extra);
        let mut b = vec![seed, mint_b.as_slice()]; b.extend(&extra);
        assert_ne!(Pubkey::find_program_address(&a, &program).0, Pubkey::find_program_address(&b, &program).0);
    }
}

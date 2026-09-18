//! Native bank/runtime + real SPL CPI tests. Not an SBF/validator test.
use anchor_lang::{prelude::*, AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_lang::solana_program::{entrypoint::ProgramResult, program_pack::Pack};
use anchor_spl::token::spl_token;
use neonrelay_economy::{accounts, instruction, EconomyConfigV2, EntryTicketV2, PrizeEpochV2};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{account::Account, instruction::Instruction, signature::{Keypair, Signer}, transaction::Transaction, system_program};

// Anchor 0.30 ties the slice lifetime to AccountInfo's inner lifetime. The native
// test adapter retains a small cloned slice per invocation (no unsafe casts).
// Only this short-lived test process leaks these slices; never production code.
fn entry<'a, 'b, 'c, 'd>(id: &'a Pubkey, accounts: &'b [AccountInfo<'c>], data: &'d [u8]) -> ProgramResult {
    neonrelay_economy::entry(id, Box::leak(accounts.to_vec().into_boxed_slice()), data)
}
fn pda(seeds: &[&[u8]]) -> (Pubkey, u8) { Pubkey::find_program_address(seeds, &neonrelay_economy::id()) }
fn stored(data: Vec<u8>, owner: Pubkey) -> Account {
    Account { lamports: Rent::default().minimum_balance(data.len()), data, owner, executable: false, rent_epoch: 0 }
}
fn token(mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    let state = spl_token::state::Account { mint, owner, amount,
        state: spl_token::state::AccountState::Initialized, ..Default::default() };
    let mut data = vec![0; spl_token::state::Account::LEN];
    spl_token::state::Account::pack(state, &mut data).unwrap();
    stored(data, spl_token::id())
}
fn ix(meta: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction { program_id: neonrelay_economy::id(), accounts: meta.to_account_metas(None), data: data.data() }
}
async fn send(ctx: &mut ProgramTestContext, signer: &Keypair, instruction: Instruction, ok: bool) {
    // Distinct fee-payer nonce instruction avoids cached identical signatures on
    // retries, so duplicate tests really execute the program's init constraint.
    let nonce = Keypair::new().pubkey();
    let unique = solana_sdk::system_instruction::transfer(&ctx.payer.pubkey(), &nonce, 1);
    let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(&[unique, instruction], Some(&ctx.payer.pubkey()), &[&ctx.payer, signer], hash);
    let result = ctx.banks_client.process_transaction(tx).await;
    assert_eq!(result.is_ok(), ok, "unexpected transaction result: {result:?}");
}
async fn balance(ctx: &mut ProgramTestContext, key: Pubkey) -> u64 {
    let account = ctx.banks_client.get_account(key).await.unwrap().unwrap();
    spl_token::state::Account::unpack(&account.data).unwrap().amount
}
async fn state<T: AccountDeserialize>(ctx: &mut ProgramTestContext, key: Pubkey) -> T {
    let account = ctx.banks_client.get_account(key).await.unwrap().unwrap();
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

#[tokio::test]
async fn payment_reservations_claims_and_atomic_failures() {
    let admin = Keypair::new(); let player = Keypair::new();
    let mint = Pubkey::new_unique(); let source = Pubkey::new_unique(); let treasury = Pubkey::new_unique();
    let (config, bump) = pda(&[b"neonrelay_economy_v2", mint.as_ref()]);
    let vault = anchor_spl::associated_token::get_associated_token_address(&config, &mint);
    let mut test = ProgramTest::new("neonrelay_economy", neonrelay_economy::id(), processor!(entry));
    test.add_program("spl_token", spl_token::id(), processor!(spl_token::processor::Processor::process));
    for key in [admin.pubkey(), player.pubkey()] {
        test.add_account(key, Account { lamports: 10_000_000_000, owner: system_program::id(), ..Default::default() });
    }
    // Bootstrap is deliberately seeded, not claimed as tested initialization.
    let cfg = EconomyConfigV2 { authority: admin.pubkey(), mint, treasury_ata: treasury,
        vault_ata: vault, fees: [50, 100, 500, 2000], rake_bps: 1000, reserved: 0, paused: false, bump };
    let mut data = Vec::new(); cfg.try_serialize(&mut data).unwrap();
    test.add_account(config, stored(data, neonrelay_economy::id()));
    test.add_account(source, token(mint, player.pubkey(), 100));
    test.add_account(treasury, token(mint, admin.pubkey(), 0));
    test.add_account(vault, token(mint, config, 0));
    let mut ctx = test.start_with_context().await;
    let pay = |reference: [u8; 32], tier| {
        let (ticket, _) = pda(&[b"neonrelay_entry_v2", mint.as_ref(), &reference, player.pubkey().as_ref()]);
        (ticket, ix(accounts::PayEntryV2 { player: player.pubkey(), config, player_ata: source,
            vault_ata: vault, treasury_ata: treasury, ticket, token_program: spl_token::id(), system_program: system_program::id() },
            instruction::PayEntryV2 { reference, kind: 0, tier }))
    };
    let (ticket, payment) = pay([4; 32], 0);
    send(&mut ctx, &player, payment.clone(), true).await;
    assert_eq!(balance(&mut ctx, source).await, 50);
    assert_eq!(balance(&mut ctx, treasury).await, 5);
    assert_eq!(balance(&mut ctx, vault).await, 45);
    let paid: EntryTicketV2 = state(&mut ctx, ticket).await;
    assert_eq!((paid.mint, paid.player, paid.amount), (mint, player.pubkey(), 50));
    send(&mut ctx, &player, payment, false).await;
    // Rake CPI can succeed (10 <= 50), then prize CPI fails (90 > 40).
    // Entire transaction, including ticket creation and rake, must roll back.
    let (failed_ticket, too_expensive) = pay([5; 32], 1);
    send(&mut ctx, &player, too_expensive, false).await;
    assert!(ctx.banks_client.get_account(failed_ticket).await.unwrap().is_none());
    assert_eq!(balance(&mut ctx, source).await, 50);
    assert_eq!(balance(&mut ctx, treasury).await, 5);
    assert_eq!(balance(&mut ctx, vault).await, 45);
    let pause = |authority, paused| ix(accounts::AdminV2 { authority, config }, instruction::SetPausedV2 { paused });
    send(&mut ctx, &player, pause(player.pubkey(), true), false).await;
    send(&mut ctx, &admin, pause(admin.pubkey(), true), true).await;
    send(&mut ctx, &player, pay([6; 32], 0).1, false).await;
    send(&mut ctx, &admin, pause(admin.pubkey(), false), true).await;
    let root = neonrelay_economy::merkle_leaf_v2(&player.pubkey().to_bytes(), 45, &mint.to_bytes());
    let publish = |epoch: u64, total| {
        let (prizes, _) = pda(&[b"neonrelay_prizes_v2", mint.as_ref(), &epoch.to_le_bytes()]);
        (prizes, ix(accounts::PublishPrizesV2 { authority: admin.pubkey(), config, vault_ata: vault, prizes, system_program: system_program::id() },
            instruction::PublishPrizesV2 { epoch, root, total, leaf_count: 1 }))
    };
    let (prizes, publication) = publish(1, 45);
    send(&mut ctx, &admin, publication.clone(), true).await;
    send(&mut ctx, &admin, publication, false).await;
    let (excess_epoch, excess) = publish(2, 1);
    send(&mut ctx, &admin, excess, false).await;
    assert!(ctx.banks_client.get_account(excess_epoch).await.unwrap().is_none());
    assert_eq!(state::<EconomyConfigV2>(&mut ctx, config).await.reserved, 45);
    let (claim, _) = pda(&[b"neonrelay_claim_v2", mint.as_ref(), &1u64.to_le_bytes(), player.pubkey().as_ref()]);
    let claim_ix = |amount| ix(accounts::ClaimPrizeV2 { player: player.pubkey(), config, player_ata: source,
        vault_ata: vault, prizes, claim, token_program: spl_token::id(), system_program: system_program::id() },
        instruction::ClaimPrizeV2 { epoch: 1, amount, leaf_index: 0, proof: vec![] });
    send(&mut ctx, &player, claim_ix(44), false).await;
    assert!(ctx.banks_client.get_account(claim).await.unwrap().is_none());
    assert_eq!(state::<EconomyConfigV2>(&mut ctx, config).await.reserved, 45);
    send(&mut ctx, &admin, pause(admin.pubkey(), true), true).await;
    send(&mut ctx, &player, claim_ix(45), false).await;
    send(&mut ctx, &admin, pause(admin.pubkey(), false), true).await;
    send(&mut ctx, &player, claim_ix(45), true).await;
    send(&mut ctx, &player, claim_ix(45), false).await;
    assert_eq!(balance(&mut ctx, source).await, 95);
    assert_eq!(balance(&mut ctx, vault).await, 0);
    assert_eq!(balance(&mut ctx, treasury).await, 5);
    assert_eq!(state::<EconomyConfigV2>(&mut ctx, config).await.reserved, 0);
    assert_eq!(state::<PrizeEpochV2>(&mut ctx, prizes).await.remaining, 0);
}

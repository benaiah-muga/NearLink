use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use tls_codec::{Deserialize, Serialize};

fn credential(
    identity: &str,
    suite: Ciphersuite,
    provider: &impl OpenMlsProvider,
) -> (CredentialWithKey, SignatureKeyPair) {
    let credential = BasicCredential::new(identity.as_bytes().to_vec());
    let signer = SignatureKeyPair::new(suite.signature_algorithm()).unwrap();
    signer.store(provider.storage()).unwrap();
    (
        CredentialWithKey {
            credential: credential.into(),
            signature_key: signer.public().into(),
        },
        signer,
    )
}

fn encode(message: &MlsMessageOut) -> Vec<u8> {
    message.tls_serialize_detached().unwrap()
}

fn decode(bytes: &[u8]) -> MlsMessageIn {
    MlsMessageIn::tls_deserialize(&mut bytes.to_vec().as_slice()).unwrap()
}

#[test]
fn native_create_join_encrypt_remove_and_reload() {
    let suite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
    let alice_provider = OpenMlsRustCrypto::default();
    let bob_provider = OpenMlsRustCrypto::default();
    let (alice_credential, alice_signer) = credential("alice", suite, &alice_provider);
    let (bob_credential, bob_signer) = credential("bob", suite, &bob_provider);

    let bob_key_package = KeyPackage::builder()
        .build(suite, &bob_provider, &bob_signer, bob_credential)
        .unwrap();

    let config = MlsGroupCreateConfig::builder().ciphersuite(suite).build();
    let mut alice = MlsGroup::new(&alice_provider, &alice_signer, &config, alice_credential)
        .expect("create group");
    let group_id = alice.group_id().clone();
    assert_eq!(alice.members().count(), 1);

    let (_add_commit, welcome_out, _group_info) = alice
        .add_members(
            &alice_provider,
            &alice_signer,
            std::slice::from_ref(bob_key_package.key_package()),
        )
        .expect("add Bob with KeyPackage");
    alice.merge_pending_commit(&alice_provider).unwrap();
    assert_eq!(alice.members().count(), 2);

    let welcome_in = match decode(&encode(&welcome_out)).extract() {
        MlsMessageBodyIn::Welcome(welcome) => welcome,
        other => panic!("expected Welcome body, got {other:?}"),
    };
    let mut bob = StagedWelcome::new_from_welcome(
        &bob_provider,
        &MlsGroupJoinConfig::default(),
        welcome_in,
        Some(alice.export_ratchet_tree().into()),
    )
    .expect("stage Welcome join")
    .into_group(&bob_provider)
    .expect("join group from Welcome");
    assert_eq!(bob.members().count(), 2);
    assert_eq!(bob.group_id(), &group_id);

    let plaintext = b"MLS application payload";
    let ciphertext = alice
        .create_message(&alice_provider, &alice_signer, plaintext)
        .expect("encrypt application payload");
    let parsed_ciphertext = decode(&encode(&ciphertext))
        .try_into_protocol_message()
        .unwrap();
    let processed = bob
        .process_message(&bob_provider, parsed_ciphertext)
        .expect("decrypt payload");
    match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(message) => {
            assert_eq!(message.into_bytes(), plaintext);
        }
        other => panic!("expected decrypted application message, got {other:?}"),
    }

    let bob_leaf_index = bob.own_leaf_index();
    let (remove_commit, _welcome, _group_info) = alice
        .remove_members(&alice_provider, &alice_signer, &[bob_leaf_index])
        .expect("create member removal Commit");
    alice.merge_pending_commit(&alice_provider).unwrap();
    assert_eq!(alice.members().count(), 1);

    let processed_commit = bob
        .process_message(
            &bob_provider,
            decode(&encode(&remove_commit))
                .try_into_protocol_message()
                .unwrap(),
        )
        .expect("removed member processes the Commit");
    let staged_commit = match processed_commit.into_content() {
        ProcessedMessageContent::StagedCommitMessage(staged_commit) => *staged_commit,
        other => panic!("expected staged removal Commit, got {other:?}"),
    };
    assert!(staged_commit.self_removed());
    bob.merge_staged_commit(&bob_provider, staged_commit)
        .unwrap();
    assert!(!bob.is_active());
    assert!(bob
        .create_message(&bob_provider, &bob_signer, b"after removal")
        .is_err());

    let reloaded_alice = MlsGroup::load(alice_provider.storage(), &group_id)
        .expect("load group from the provider storage")
        .expect("group state is present");
    assert_eq!(reloaded_alice.members().count(), 1);
    assert_eq!(reloaded_alice.epoch(), alice.epoch());
}

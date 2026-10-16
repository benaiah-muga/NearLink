use mls_rs::mls_rs_codec::MlsEncode;
use mls_rs::{
    group::ReceivedMessage, test_utils::generate_basic_client, CipherSuite, CryptoProvider,
    ProtocolVersion,
};

const SUITE: CipherSuite = CipherSuite::P256_AES128;
const APP_BODY: &[u8] = b"nearlink feasibility message";

async fn run_group_flow<C: CryptoProvider + Clone>(provider: C) {
    assert!(provider.supported_cipher_suites().contains(&SUITE));

    let owner = generate_basic_client(
        SUITE,
        ProtocolVersion::MLS_10,
        0,
        None,
        false,
        &provider,
        None,
    )
    .await;
    let member = generate_basic_client(
        SUITE,
        ProtocolVersion::MLS_10,
        1,
        None,
        false,
        &provider,
        None,
    )
    .await;

    let group_id = b"nearlink-nl61-feasibility".to_vec();
    let mut owner_group = owner
        .group_builder()
        .unwrap()
        .with_group_id(group_id.clone())
        .build()
        .await
        .unwrap();

    let key_package = member
        .generate_key_package_message(Default::default(), Default::default(), None)
        .await
        .unwrap();
    let key_package_size = key_package.mls_encode_to_vec().unwrap().len();

    let add_commit = owner_group
        .commit_builder()
        .add_member(key_package)
        .unwrap()
        .build()
        .await
        .unwrap();
    let add_commit_size = add_commit.commit_message.mls_encode_to_vec().unwrap().len();
    let welcome = add_commit.welcome_messages[0].clone();
    let welcome_size = welcome.mls_encode_to_vec().unwrap().len();
    owner_group.apply_pending_commit().await.unwrap();
    let (mut member_group, _) = member.join_group(None, &welcome, None).await.unwrap();

    let application = owner_group
        .encrypt_application_message(APP_BODY, Vec::new())
        .await
        .unwrap();
    let application_size = application.mls_encode_to_vec().unwrap().len();
    match member_group
        .process_incoming_message(application)
        .await
        .unwrap()
    {
        ReceivedMessage::ApplicationMessage(description) => {
            assert_eq!(description.data(), APP_BODY);
        }
        _ => panic!("expected an application message"),
    }

    let member_update = member_group.propose_update(Vec::new()).await.unwrap();
    let member_update_size = member_update.mls_encode_to_vec().unwrap().len();
    owner_group
        .process_incoming_message(member_update)
        .await
        .unwrap();
    let update_commit = owner_group.commit(Vec::new()).await.unwrap();
    owner_group.apply_pending_commit().await.unwrap();
    member_group
        .process_incoming_message(update_commit.commit_message)
        .await
        .unwrap();

    owner_group.write_to_storage().await.unwrap();
    let reloaded_group = owner.load_group(&group_id).await.unwrap();
    assert_eq!(reloaded_group.current_epoch(), owner_group.current_epoch());

    let remove_commit = owner_group
        .commit_builder()
        .remove_member(1)
        .unwrap()
        .build()
        .await
        .unwrap();
    let remove_commit_size = remove_commit
        .commit_message
        .mls_encode_to_vec()
        .unwrap()
        .len();
    owner_group.apply_pending_commit().await.unwrap();
    let removal = member_group
        .process_incoming_message(remove_commit.commit_message)
        .await
        .unwrap();
    match removal {
        ReceivedMessage::Commit(description) => {
            assert!(matches!(
                description.effect,
                mls_rs::group::CommitEffect::Removed { .. }
            ));
        }
        _ => panic!("expected the removed member to observe a removal commit"),
    }
    assert!(owner_group.member_at_index(1).is_none());

    let metrics = format!(
        "suite=2 key_package_bytes={key_package_size} add_commit_bytes={add_commit_size} welcome_bytes={welcome_size} app_bytes={application_size} update_bytes={member_update_size} remove_commit_bytes={remove_commit_size}"
    );
    #[cfg(not(target_arch = "wasm32"))]
    println!("{metrics}");
    #[cfg(target_arch = "wasm32")]
    web_sys::console::log_1(&metrics.into());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn host_native_group_flow() {
    futures::executor::block_on(run_group_flow(
        mls_rs_crypto_rustcrypto::RustCryptoProvider::with_enabled_cipher_suites(vec![SUITE]),
    ));
}

#[cfg(target_arch = "wasm32")]
wasm_bindgen_test::wasm_bindgen_test_configure!(run_in_browser);

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen_test::wasm_bindgen_test]
async fn chromium_webcrypto_group_flow() {
    run_group_flow(mls_rs_crypto_webcrypto::WebCryptoProvider::new()).await;
}

#!/usr/bin/env bash
# 初回だけ Google Cloud Shell で実行する。
#  - 必要なAPIの有効化
#  - Firestore（東京）の作成
#  - GitHub Actions から鍵なしでデプロイするための設定（Workload Identity 連携）
set -euo pipefail
PROJECT_ID=prtimes-inbox
REPO=ItaruKato/prtimes-inbox
SA_NAME=github-deploy

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

echo "== APIを有効化（数分かかります）"
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  cloudresourcemanager.googleapis.com serviceusage.googleapis.com firestore.googleapis.com \
  cloudfunctions.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  run.googleapis.com cloudscheduler.googleapis.com eventarc.googleapis.com pubsub.googleapis.com \
  firebase.googleapis.com firebasehosting.googleapis.com firebaserules.googleapis.com compute.googleapis.com \
  cloudbilling.googleapis.com firebaseextensions.googleapis.com

echo "== Firestore（東京）を作成"
gcloud firestore databases describe --database='(default)' >/dev/null 2>&1 \
  || gcloud firestore databases create --location=asia-northeast1 --type=firestore-native

echo "== デプロイ用サービスアカウント"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 \
  || { gcloud iam service-accounts create "$SA_NAME" --display-name="GitHub Actions deploy"; echo "（反映待ち 30秒）"; sleep 30; }
for ROLE in roles/editor roles/firebase.admin roles/cloudfunctions.admin roles/run.admin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="$ROLE" --condition=None --quiet >/dev/null
done
# Cloud Functions のビルドに使われるアカウントにビルド権限を付ける
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role=roles/cloudbuild.builds.builder --condition=None --quiet >/dev/null || true

echo "== GitHub（$REPO の main ブランチ）だけがデプロイできるようにする"
gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools create github --location=global --display-name="GitHub"
gcloud iam workload-identity-pools providers describe github --location=global --workload-identity-pool=github >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools providers create-oidc github --location=global --workload-identity-pool=github \
    --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='$REPO' && assertion.ref=='refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding "$SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO" \
  --quiet >/dev/null

echo
echo "完了しました。次の1行をClaudeに送ってください："
echo "PROJECT_NUMBER=$PROJECT_NUMBER"

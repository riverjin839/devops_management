// ============================================
// K8s Daily Monitor - Jenkins CI Pipeline
// ============================================
// 트리거: Git push → Jenkins → 빌드/테스트/이미지 Push → ArgoCD 동기화
//
// Jenkins 필요 플러그인: Pipeline, Docker Pipeline, Git
// Jenkins Credentials 필요:
//   - 'registry-credentials' : Private Registry 로그인 (Username/Password)
//   - 'git-credentials'      : Git 접근용 (폐쇄망 Git)
//   - 'argocd-auth-token'    : ArgoCD API 토큰 (Secret text)
// 선택 환경변수:
//   - TEST_DATABASE_URL      : 백엔드 테스트 전용 PostgreSQL(DB 이름에 test 포함). 미설정이면 테스트 단계 SKIP

pipeline {
    agent any

    environment {
        // -- 레지스트리 설정 (환경에 맞게 수정)
        REGISTRY       = "${env.REGISTRY ?: '10.61.162.101:5000'}"
        IMAGE_BACKEND  = "${REGISTRY}/k8s-monitor/backend"
        IMAGE_FRONTEND = "${REGISTRY}/k8s-monitor/frontend"
        IMAGE_TAG      = "${env.GIT_COMMIT?.take(8) ?: 'latest'}"

        // -- ArgoCD 설정
        ARGOCD_SERVER  = "${env.ARGOCD_SERVER ?: 'argocd.company.internal'}"
        ARGOCD_APP     = "k8s-daily-monitor"

        // -- Helm Chart 경로
        HELM_CHART     = "deploy/helm/k8s-daily-monitor"
    }

    options {
        timeout(time: 30, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    stages {
        // ============================================
        // 1. 체크아웃
        // ============================================
        stage('Checkout') {
            steps {
                checkout scm
                script {
                    env.GIT_SHORT = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    env.IMAGE_TAG = env.GIT_SHORT
                }
                echo "Git Commit: ${env.GIT_SHORT}"
            }
        }

        // ============================================
        // 2. 백엔드 테스트
        // ============================================
        stage('Backend Test') {
            steps {
                dir('backend') {
                    // 테스트는 DB 에 계정·설정 행을 만들고 지운다 — 운영 DB 를 가리키면 개인 설정이
                    // 망가진다(배포 후 사이드바 설치 목록이 초기화되던 버그). 그래서 테스트 전용 DB 를
                    // TEST_DATABASE_URL 로 명시해야만 돌고(DB 이름에 test 필수 — tests/conftest.py 가드),
                    // 실패하면 이후 단계(이미지 빌드·배포)를 멈춘다. 미설정이면 명시적으로 건너뛴다.
                    sh '''
                        if [ -z "${TEST_DATABASE_URL:-}" ]; then
                            echo "SKIP: TEST_DATABASE_URL 미설정 — 백엔드 테스트를 건너뛴다(GitHub Actions CI 가 머지 전 게이트)."
                            exit 0
                        fi
                        python3 -m venv venv
                        . venv/bin/activate
                        pip install -r requirements.txt --quiet
                        pip install pytest pytest-asyncio httpx --quiet
                        DATABASE_URL="$TEST_DATABASE_URL" pytest -v --tb=short
                    '''
                }
            }
        }

        // ============================================
        // 3. 프론트엔드 린트 & 빌드 체크
        // ============================================
        stage('Frontend Lint') {
            steps {
                dir('frontend') {
                    sh '''
                        npm ci --quiet
                        npm run lint || echo "WARNING: Lint issues"
                        npx tsc --noEmit || echo "WARNING: Type errors"
                    '''
                }
            }
        }

        // ============================================
        // 4. 컨테이너 이미지 빌드
        // ============================================
        stage('Build Images') {
            parallel {
                stage('Backend Image') {
                    steps {
                        sh """
                            docker build \
                                -t ${IMAGE_BACKEND}:${IMAGE_TAG} \
                                -t ${IMAGE_BACKEND}:latest \
                                -f backend/Dockerfile \
                                backend/
                        """
                    }
                }
                stage('Frontend Image') {
                    steps {
                        sh """
                            docker build \
                                -t ${IMAGE_FRONTEND}:${IMAGE_TAG} \
                                -t ${IMAGE_FRONTEND}:latest \
                                -f frontend/Dockerfile \
                                frontend/
                        """
                    }
                }
            }
        }

        // ============================================
        // 5. 이미지 Push
        // ============================================
        stage('Push Images') {
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'registry-credentials',
                    usernameVariable: 'REG_USER',
                    passwordVariable: 'REG_PASS'
                )]) {
                    sh """
                        echo "\${REG_PASS}" | docker login ${REGISTRY} -u "\${REG_USER}" --password-stdin

                        docker push ${IMAGE_BACKEND}:${IMAGE_TAG}
                        docker push ${IMAGE_BACKEND}:latest
                        docker push ${IMAGE_FRONTEND}:${IMAGE_TAG}
                        docker push ${IMAGE_FRONTEND}:latest
                    """
                }
            }
        }

        // ============================================
        // 6. Helm Chart 검증
        // ============================================
        stage('Helm Lint') {
            steps {
                sh """
                    helm lint ${HELM_CHART} \
                        -f ${HELM_CHART}/values-prod.yaml \
                        --set backend.image.tag=${IMAGE_TAG} \
                        --set frontend.image.tag=${IMAGE_TAG} \
                        --set global.imageRegistry=${REGISTRY}
                """
            }
        }

        // ============================================
        // 7. ArgoCD 동기화 트리거 (CD)
        // ============================================
        stage('Trigger ArgoCD') {
            when {
                branch 'main'
            }
            steps {
                withCredentials([string(
                    credentialsId: 'argocd-auth-token',
                    variable: 'ARGOCD_TOKEN'
                )]) {
                    sh """
                        # ArgoCD CLI 또는 API로 이미지 태그 업데이트 후 Sync
                        argocd app set ${ARGOCD_APP} \
                            --server ${ARGOCD_SERVER} \
                            --auth-token "\${ARGOCD_TOKEN}" \
                            --grpc-web \
                            -p backend.image.tag=${IMAGE_TAG} \
                            -p frontend.image.tag=${IMAGE_TAG} \
                            -p global.imageRegistry=${REGISTRY} || true

                        argocd app sync ${ARGOCD_APP} \
                            --server ${ARGOCD_SERVER} \
                            --auth-token "\${ARGOCD_TOKEN}" \
                            --grpc-web \
                            --async || true
                    """
                }
                echo "ArgoCD Sync triggered for image tag: ${IMAGE_TAG}"
            }
        }
    }

    post {
        success {
            echo """
            ========================================
            CI 완료
            ========================================
            Backend:  ${IMAGE_BACKEND}:${IMAGE_TAG}
            Frontend: ${IMAGE_FRONTEND}:${IMAGE_TAG}
            ========================================
            """
        }
        failure {
            echo 'Pipeline failed!'
        }
        always {
            // 빌드 후 이미지 정리
            sh "docker rmi ${IMAGE_BACKEND}:${IMAGE_TAG} ${IMAGE_FRONTEND}:${IMAGE_TAG} || true"
        }
    }
}

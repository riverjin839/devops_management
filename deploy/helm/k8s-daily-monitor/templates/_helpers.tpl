{{/*
차트 이름
*/}}
{{- define "k8s-daily-monitor.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
풀 네임
*/}}
{{- define "k8s-daily-monitor.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
공통 레이블
*/}}
{{- define "k8s-daily-monitor.labels" -}}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: k8s-daily-monitor
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/*
이미지 경로 생성 (글로벌 레지스트리 적용)
*/}}
{{- define "k8s-daily-monitor.image" -}}
{{- $registry := .global.imageRegistry | default "" -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry .repository (.tag | default "latest") -}}
{{- else -}}
{{- printf "%s:%s" .repository (.tag | default "latest") -}}
{{- end -}}
{{- end }}

{{/*
Database URL 생성
*/}}
{{- define "k8s-daily-monitor.databaseUrl" -}}
postgresql://{{ .Values.secrets.databaseUser }}:{{ .Values.secrets.databasePassword }}@postgres:5432/k8s_monitor
{{- end }}

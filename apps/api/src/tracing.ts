import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'voiceforge-api';
const serviceVersion = process.env.OTEL_SERVICE_VERSION ?? '0.1.0';

function buildResource() {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
  });
}

/**
 * OpenTelemetry SDK — auto-instruments HTTP, Express, and Prisma.
 *
 * Requires environment variables (optional; SDK boots even if unset):
 *   OTEL_EXPORTER_OTLP_ENDPOINT  — collector URL (e.g. https://otelcol.example.com:4318)
 *   OTEL_SERVICE_NAME            — overrides the default "voiceforge-api" name
 *   OTEL_SERVICE_VERSION         — defaults to "0.1.0"
 *
 * Both traces and metrics are exported when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * When not set, the SDK runs with no-op exporters (still useful for local debugging).
 */
function buildSDK(): NodeSDK {
  const resource = buildResource();
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const traceExporter = otlpEndpoint
    ? new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` })
    : undefined;

  const metricExporter = otlpEndpoint
    ? new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` })
    : undefined;

  const metricReader = metricExporter
    ? new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 15_000 })
    : undefined;

  return new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
}

export const otel = buildSDK();

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'voiceforge-api';
const serviceVersion = process.env.OTEL_SERVICE_VERSION ?? '0.1.0';

/**
 * OpenTelemetry SDK — auto-instruments HTTP, Express, and Prisma.
 *
 * Requires environment variables (optional; SDK boots even if unset):
 *   OTEL_EXPORTER_OTLP_ENDPOINT  — collector URL (e.g. https://otelcol.example.com:4318)
 *   OTEL_SERVICE_NAME            — overrides the default "voiceforge-api" name
 *   OTEL_SERVICE_VERSION         — defaults to "0.1.0"
 *
 * When OTEL_EXPORTER_OTLP_ENDPOINT is not set, traces are written to stdout
 * in JSON format and can be piped to pino-pretty locally.
 */
function buildSDK(): NodeSDK {
  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
  });

  const traceExporter = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OTLPTraceExporter({ url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` })
    : undefined; // SDK uses default ConsoleSpanExporter when no OTLP endpoint is set

  return new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable noisy filesystem instrumentation
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
}

export const tracing = buildSDK();
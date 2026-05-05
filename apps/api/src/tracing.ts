import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { logger } from './logging';

let sdk: NodeSDK | undefined;

export function initTracing(otelEndpoint?: string): NodeSDK | undefined {
  if (!otelEndpoint) {
    logger.debug('[tracing] OTEL_EXPORTER_OTLP_ENDPOINT not set — skipping OTel initialization');
    return undefined;
  }

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: 'voiceforge-api',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${otelEndpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-express': { enabled: true },
        '@opentelemetry/instrumentation-pg': { enabled: true },
      }),
    ],
  });

  sdk.start();
  logger.info('[tracing] OpenTelemetry SDK started — exporting to ' + otelEndpoint);
  return sdk;
}

export const otel = {
  start: () => {
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    initTracing(endpoint);
  },
  shutdown: async () => {
    if (sdk) {
      await sdk.shutdown();
      logger.info('[tracing] OpenTelemetry SDK shut down');
    }
  },
};
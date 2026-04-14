import { readEnvFile } from '../env.js';
import { createChildLogger } from '../logger.js';

import { registerIntegration } from './registry.js';
import {
  getIntegrationSettings,
  isIntegrationEnabled,
  saveIntegrationSettings,
} from './settings-store.js';
import type {
  CredentialInputStep,
  IntegrationDefinition,
  IntegrationNotification,
  IntegrationTool,
} from './types.js';

const log = createChildLogger({ integration: 'google-places' });

type CostTier = 'essentials' | 'pro';

interface PlacesApiErrorPayload {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

interface LocalizedText {
  text?: string;
}

interface Review {
  rating?: number;
  relativePublishTimeDescription?: string;
  publishTime?: string;
}

interface Place {
  id?: string;
  displayName?: LocalizedText;
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  types?: string[];
  regularOpeningHours?: {
    weekdayDescriptions?: string[];
  };
  currentOpeningHours?: {
    openNow?: boolean;
    weekdayDescriptions?: string[];
  };
  websiteUri?: string;
  nationalPhoneNumber?: string;
  googleMapsUri?: string;
  editorialSummary?: LocalizedText;
  reviews?: Review[];
}

interface SearchResponse {
  places?: Place[];
}

const INTEGRATION_NAME = 'google-places';
const API_KEY_SETTING = 'GOOGLE_MAPS_API_KEY';
const VALIDATED_AT_SETTING = 'apiKeyValidatedAt';
const VALIDATION_ERROR_SETTING = 'apiKeyValidationError';
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 20;
const MAX_RADIUS_METERS = 50_000;

const SEARCH_FIELD_MASKS: Record<CostTier, string> = {
  essentials: [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.rating',
    'places.userRatingCount',
    'places.priceLevel',
    'places.types',
    'places.googleMapsUri',
  ].join(','),
  pro: [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.rating',
    'places.userRatingCount',
    'places.priceLevel',
    'places.types',
    'places.regularOpeningHours.weekdayDescriptions',
    'places.websiteUri',
    'places.nationalPhoneNumber',
    'places.googleMapsUri',
  ].join(','),
};

const DETAILS_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'rating',
  'userRatingCount',
  'priceLevel',
  'types',
  'regularOpeningHours.weekdayDescriptions',
  'currentOpeningHours.openNow',
  'currentOpeningHours.weekdayDescriptions',
  'websiteUri',
  'nationalPhoneNumber',
  'googleMapsUri',
  'editorialSummary',
  'reviews.rating',
  'reviews.relativePublishTimeDescription',
  'reviews.publishTime',
].join(',');

function getApiKey(settings?: Record<string, unknown>): string {
  const env = readEnvFile([API_KEY_SETTING]);
  return (
    env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    String(settings?.[API_KEY_SETTING] || '')
  ).trim();
}

function getCostTier(settings?: Record<string, unknown>): CostTier {
  return settings?.costTier === 'essentials' ? 'essentials' : 'pro';
}

function clampMaxResults(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(MAX_RESULTS_LIMIT, Math.trunc(parsed)));
}

function clampRadius(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('radius must be a positive number');
  }
  return Math.min(MAX_RADIUS_METERS, parsed);
}

function parseMinRating(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5) {
    throw new Error('minRating must be between 0 and 5');
  }
  return parsed;
}

function parseCoordinate(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid number`);
  }
  return parsed;
}

async function parsePlacesError(response: Response): Promise<Error> {
  const payload = (await response.json().catch(() => ({}))) as PlacesApiErrorPayload;
  const message =
    payload.error?.message || response.statusText || 'Google Places request failed';
  return new Error(`Google Places request failed (${response.status}): ${message}`);
}

async function placesFetch<TResponse>(
  url: string,
  init: RequestInit,
  fieldMask: string,
  apiKey: string,
  operation: string,
  metadata: Record<string, unknown> = {},
): Promise<TResponse> {
  const startedAt = Date.now();
  log.info(
    {
      operation,
      method: init.method || 'GET',
      url,
      fieldMask,
      ...metadata,
    },
    'Calling Google Places API',
  );

  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const error = await parsePlacesError(response);
    log.error(
      {
        operation,
        method: init.method || 'GET',
        url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        ...metadata,
      },
      'Google Places API call failed',
    );
    throw error;
  }

  log.info(
    {
      operation,
      method: init.method || 'GET',
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      ...metadata,
    },
    'Google Places API call completed',
  );

  return (await response.json()) as TResponse;
}

export function mapPlaceSummary(place: Place): Record<string, unknown> {
  return {
    placeId: place.id || '',
    name: place.displayName?.text || '',
    formattedAddress: place.formattedAddress || '',
    rating: place.rating ?? null,
    userRatingCount: place.userRatingCount ?? null,
    priceLevel: place.priceLevel || null,
    types: place.types || [],
    hours: place.regularOpeningHours?.weekdayDescriptions || [],
    websiteUri: place.websiteUri || null,
    nationalPhoneNumber: place.nationalPhoneNumber || null,
    googleMapsUri: place.googleMapsUri || null,
  };
}

function filterByMinRating(
  places: Place[],
  minRating: number | null,
  maxResults: number,
): Place[] {
  return places
    .filter((place) => minRating == null || (place.rating ?? 0) >= minRating)
    .slice(0, maxResults);
}

export async function searchPlacesText(input: {
  apiKey: string;
  query: string;
  maxResults: number;
  minRating?: number | null;
  openNow?: boolean;
  type?: string;
  costTier?: CostTier;
}): Promise<Record<string, unknown>> {
  const payload = await placesFetch<SearchResponse>(
    'https://places.googleapis.com/v1/places:searchText',
    {
      method: 'POST',
      body: JSON.stringify({
        textQuery: input.query,
        maxResultCount: input.maxResults,
        ...(input.openNow ? { openNow: true } : {}),
        ...(input.type ? { includedType: input.type } : {}),
      }),
    },
    SEARCH_FIELD_MASKS[input.costTier || 'pro'],
    input.apiKey,
    'searchText',
    {
      query: input.query,
      maxResults: input.maxResults,
      minRating: input.minRating ?? null,
      openNow: input.openNow === true,
      type: input.type || null,
      costTier: input.costTier || 'pro',
    },
  );

  const places = filterByMinRating(
    payload.places || [],
    input.minRating ?? null,
    input.maxResults,
  );

  return {
    query: input.query,
    requestedMaxResults: input.maxResults,
    returnedCount: places.length,
    results: places.map(mapPlaceSummary),
  };
}

export async function searchPlacesNearby(input: {
  apiKey: string;
  latitude: number;
  longitude: number;
  radius: number;
  type?: string;
  maxResults: number;
  minRating?: number | null;
  costTier?: CostTier;
}): Promise<Record<string, unknown>> {
  const payload = await placesFetch<SearchResponse>(
    'https://places.googleapis.com/v1/places:searchNearby',
    {
      method: 'POST',
      body: JSON.stringify({
        ...(input.type ? { includedTypes: [input.type] } : {}),
        maxResultCount: input.maxResults,
        locationRestriction: {
          circle: {
            center: {
              latitude: input.latitude,
              longitude: input.longitude,
            },
            radius: input.radius,
          },
        },
      }),
    },
    SEARCH_FIELD_MASKS[input.costTier || 'pro'],
    input.apiKey,
    'searchNearby',
    {
      latitude: input.latitude,
      longitude: input.longitude,
      radius: input.radius,
      type: input.type || null,
      maxResults: input.maxResults,
      minRating: input.minRating ?? null,
      costTier: input.costTier || 'pro',
    },
  );

  const places = filterByMinRating(
    payload.places || [],
    input.minRating ?? null,
    input.maxResults,
  );

  return {
    center: {
      latitude: input.latitude,
      longitude: input.longitude,
    },
    radius: input.radius,
    returnedCount: places.length,
    results: places.map(mapPlaceSummary),
  };
}

export async function getPlaceDetails(input: {
  apiKey: string;
  placeId: string;
}): Promise<Record<string, unknown>> {
  const place = await placesFetch<Place>(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(input.placeId)}`,
    {
      method: 'GET',
    },
    DETAILS_FIELD_MASK,
    input.apiKey,
    'placeDetails',
    {
      placeId: input.placeId,
    },
  );

  const reviews = (place.reviews || []).map((review) => ({
    rating: review.rating ?? null,
    relativePublishTimeDescription:
      review.relativePublishTimeDescription || null,
    publishTime: review.publishTime || null,
  }));

  return {
    placeId: place.id || input.placeId,
    name: place.displayName?.text || '',
    formattedAddress: place.formattedAddress || '',
    rating: place.rating ?? null,
    userRatingCount: place.userRatingCount ?? null,
    priceLevel: place.priceLevel || null,
    types: place.types || [],
    regularHours: place.regularOpeningHours?.weekdayDescriptions || [],
    currentHours: {
      openNow: place.currentOpeningHours?.openNow ?? null,
      weekdayDescriptions: place.currentOpeningHours?.weekdayDescriptions || [],
    },
    websiteUri: place.websiteUri || null,
    nationalPhoneNumber: place.nationalPhoneNumber || null,
    googleMapsUri: place.googleMapsUri || null,
    editorialSummary: place.editorialSummary?.text || null,
    reviewSummary: {
      reviewCount: reviews.length,
      reviews,
    },
  };
}

async function validateApiKey(apiKey: string): Promise<{
  valid: boolean;
  error?: string;
}> {
  if (!apiKey) {
    return { valid: false, error: 'Google Maps API key is required' };
  }

  try {
    await searchPlacesText({
      apiKey,
      query: 'coffee',
      maxResults: 1,
      costTier: 'essentials',
    });
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error:
        error instanceof Error
          ? error.message
          : 'Google Places API key validation failed',
    };
  }
}

function saveValidationState(
  settings: Record<string, unknown>,
  validation: { valid: boolean; error?: string },
): void {
  saveIntegrationSettings(INTEGRATION_NAME, {
    ...settings,
    [VALIDATED_AT_SETTING]: new Date().toISOString(),
    [VALIDATION_ERROR_SETTING]: validation.valid ? '' : validation.error || '',
  });
}

async function validateAndPersistApiKey(
  settings: Record<string, unknown>,
): Promise<void> {
  const apiKey = getApiKey(settings);
  if (!apiKey) {
    saveIntegrationSettings(INTEGRATION_NAME, {
      ...settings,
      [VALIDATED_AT_SETTING]: '',
      [VALIDATION_ERROR_SETTING]: '',
    });
    return;
  }

  const validation = await validateApiKey(apiKey);
  saveValidationState(settings, validation);
  if (!validation.valid) {
    throw new Error(validation.error || 'Google Places API key validation failed');
  }
}

const credentialStep: CredentialInputStep = {
  type: 'credential_input',
  label: 'Google Maps API Key',
  description:
    'Enable Places API (New) in Google Cloud, then paste an API key to power place search tools.',
  helpUrl: 'https://console.cloud.google.com/apis/credentials',
  fields: [
    {
      key: API_KEY_SETTING,
      label: 'API Key',
      type: 'password',
      required: true,
    },
  ],
  validate: async (values) => {
    return validateApiKey(String(values[API_KEY_SETTING] || '').trim());
  },
  save: async (values) => {
    const settings = getIntegrationSettings(INTEGRATION_NAME);
    saveIntegrationSettings(INTEGRATION_NAME, {
      ...settings,
      [API_KEY_SETTING]: String(values[API_KEY_SETTING] || '').trim(),
      [VALIDATED_AT_SETTING]: new Date().toISOString(),
      [VALIDATION_ERROR_SETTING]: '',
    });
  },
  isComplete: async () => Boolean(getApiKey(getIntegrationSettings(INTEGRATION_NAME))),
};

const searchTool: IntegrationTool = {
  name: 'google_places.search',
  description:
    'Search for restaurants, businesses, addresses, and points of interest using Google Places text search.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language place query, such as "coffee near Gastown".',
      },
      maxResults: {
        type: 'integer',
        description: `Maximum results to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS_LIMIT}).`,
      },
      minRating: {
        type: 'number',
        description: 'Optional minimum rating filter applied client-side.',
      },
      openNow: {
        type: 'boolean',
        description: 'Only return places that are open right now.',
      },
      type: {
        type: 'string',
        description: 'Optional Google place type, such as restaurant or cafe.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  location: 'host',
  execute: async (args, ctx) => {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query is required');

    const apiKey = getApiKey(ctx.settings);
    if (!apiKey) {
      throw new Error(
        'Google Places is not configured. Add a Google Maps API key in the integration setup.',
      );
    }

    const defaultMaxResults = clampMaxResults(
      ctx.settings.defaultMaxResults,
      DEFAULT_MAX_RESULTS,
    );

    return JSON.stringify(
      await searchPlacesText({
        apiKey,
        query,
        maxResults: clampMaxResults(args.maxResults, defaultMaxResults),
        minRating: parseMinRating(args.minRating),
        openNow: args.openNow === true,
        type: typeof args.type === 'string' ? args.type.trim() : '',
        costTier: getCostTier(ctx.settings),
      }),
    );
  },
};

const nearbyTool: IntegrationTool = {
  name: 'google_places.nearby',
  description:
    'Find places near a specific latitude/longitude and radius using Google Places nearby search.',
  parameters: {
    type: 'object',
    properties: {
      latitude: {
        type: 'number',
        description: 'Latitude of the search center.',
      },
      longitude: {
        type: 'number',
        description: 'Longitude of the search center.',
      },
      radius: {
        type: 'number',
        description: `Search radius in meters (max ${MAX_RADIUS_METERS}).`,
      },
      type: {
        type: 'string',
        description: 'Optional Google place type, such as restaurant or gas_station.',
      },
      maxResults: {
        type: 'integer',
        description: `Maximum results to return (default 10, max ${MAX_RESULTS_LIMIT}).`,
      },
      minRating: {
        type: 'number',
        description: 'Optional minimum rating filter applied client-side.',
      },
    },
    required: ['latitude', 'longitude', 'radius'],
    additionalProperties: false,
  },
  location: 'host',
  execute: async (args, ctx) => {
    const apiKey = getApiKey(ctx.settings);
    if (!apiKey) {
      throw new Error(
        'Google Places is not configured. Add a Google Maps API key in the integration setup.',
      );
    }

    return JSON.stringify(
      await searchPlacesNearby({
        apiKey,
        latitude: parseCoordinate(args.latitude, 'latitude'),
        longitude: parseCoordinate(args.longitude, 'longitude'),
        radius: clampRadius(args.radius),
        type: typeof args.type === 'string' ? args.type.trim() : '',
        maxResults: clampMaxResults(args.maxResults, 10),
        minRating: parseMinRating(args.minRating),
        costTier: getCostTier(ctx.settings),
      }),
    );
  },
};

const detailsTool: IntegrationTool = {
  name: 'google_places.details',
  description:
    'Fetch full details for a Google Place by place ID, including current hours and review metadata.',
  parameters: {
    type: 'object',
    properties: {
      placeId: {
        type: 'string',
        description: 'Google Place ID from a previous search result.',
      },
    },
    required: ['placeId'],
    additionalProperties: false,
  },
  location: 'host',
  execute: async (args, ctx) => {
    const placeId = String(args.placeId || '').trim();
    if (!placeId) throw new Error('placeId is required');

    const apiKey = getApiKey(ctx.settings);
    if (!apiKey) {
      throw new Error(
        'Google Places is not configured. Add a Google Maps API key in the integration setup.',
      );
    }

    return JSON.stringify(
      await getPlaceDetails({
        apiKey,
        placeId,
      }),
    );
  },
};

const googlePlacesIntegration: IntegrationDefinition = {
  name: INTEGRATION_NAME,
  description:
    'Google Places search for restaurants, businesses, points of interest, and addresses',
  core: false,
  version: '1.0.0',
  credentials: [
    {
      key: API_KEY_SETTING,
      label: 'Google Maps API Key',
      type: 'api_key',
      envVar: API_KEY_SETTING,
      required: true,
    },
  ],
  settings: {
    schema: {
      type: 'object',
      properties: {
        [API_KEY_SETTING]: {
          type: 'string',
          title: 'Google Maps API Key',
          description: 'Stored locally for host-side Google Places requests.',
          sensitive: true,
        },
        defaultMaxResults: {
          type: 'integer',
          title: 'Default max results',
          description: 'Default number of places returned when a tool call omits maxResults.',
          default: DEFAULT_MAX_RESULTS,
          minimum: 1,
          maximum: MAX_RESULTS_LIMIT,
        },
        costTier: {
          type: 'string',
          title: 'Cost tier',
          description:
            'Essentials returns lower-cost place summaries. Pro adds hours, phone, and website fields.',
          enum: ['essentials', 'pro'],
          enumLabels: ['Essentials (basic info)', 'Pro (hours, phone, website)'],
          default: 'pro',
        },
      },
    },
    defaults: {
      [API_KEY_SETTING]: '',
      defaultMaxResults: DEFAULT_MAX_RESULTS,
      costTier: 'pro',
    },
  },
  adminPage: {
    icon: 'cilLocationPin',
    category: 'productivity',
    getStatus: async (ctx) => {
      if (!isIntegrationEnabled(INTEGRATION_NAME)) {
        return {
          state: 'unconfigured',
          message: 'Integration disabled',
        };
      }

      const apiKey = getApiKey(ctx.settings);
      if (!apiKey) {
        return {
          state: 'unconfigured',
          message: 'Google Maps API key not configured',
        };
      }

      const validationError = String(ctx.settings[VALIDATION_ERROR_SETTING] || '');
      const validatedAt = String(ctx.settings[VALIDATED_AT_SETTING] || '');
      if (validationError) {
        return {
          state: 'degraded',
          message: validationError,
        };
      }

      return {
        state: 'online',
        message: validatedAt
          ? `Connected (${getCostTier(ctx.settings)} tier, validated ${validatedAt.split('T')[0]})`
          : `Connected (${getCostTier(ctx.settings)} tier)`,
      };
    },
    getNotifications: async (ctx) => {
      const notifications: IntegrationNotification[] = [];
      const apiKey = getApiKey(ctx.settings);

      if (!apiKey) {
        notifications.push({
          id: 'google-places:missing-api-key',
          integration: INTEGRATION_NAME,
          severity: 'info',
          title: 'Google Maps API Key Missing',
          message: 'Configure your Google Maps API key to enable Google Places tools.',
        });
        return notifications;
      }

      const validationError = String(ctx.settings[VALIDATION_ERROR_SETTING] || '');
      if (validationError) {
        notifications.push({
          id: 'google-places:invalid-api-key',
          integration: INTEGRATION_NAME,
          severity: 'error',
          title: 'Google Maps API Key Invalid',
          message: validationError,
        });
      }

      return notifications;
    },
  },
  tools: [searchTool, nearbyTool, detailsTool],
  setup: {
    steps: [credentialStep],
    getStatus: async () => {
      const completed = await credentialStep.isComplete();
      return {
        completed,
        currentStep: completed ? 1 : 0,
        steps: [
          {
            type: 'credential_input',
            label: credentialStep.label,
            description:
              'Enable Places API (New) in your Google Cloud project, then create an API key.',
            status: completed ? 'completed' : 'pending',
          },
        ],
      };
    },
  },
  lifecycle: {
    onEnable: async (ctx) => {
      await validateAndPersistApiKey(ctx.settings);
    },
    onSettingsChange: async (prev, next) => {
      const prevApiKey = getApiKey(prev);
      const nextApiKey = getApiKey(next);
      if (prevApiKey === nextApiKey) return;
      await validateAndPersistApiKey(next);
    },
  },
};

registerIntegration(googlePlacesIntegration);

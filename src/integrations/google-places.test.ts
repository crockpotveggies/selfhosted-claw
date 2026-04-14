import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getPlaceDetails,
  searchPlacesNearby,
  searchPlacesText,
} from './google-places.js';

describe('Google Places integration helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters text search results by minRating and exposes place IDs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          places: [
            {
              id: 'low-rated',
              displayName: { text: 'Okay Coffee' },
              formattedAddress: '1 Main St',
              rating: 3.9,
              userRatingCount: 40,
              googleMapsUri: 'https://maps.google.com/?q=1',
            },
            {
              id: 'high-rated',
              displayName: { text: 'Great Coffee' },
              formattedAddress: '2 Main St',
              rating: 4.8,
              userRatingCount: 320,
              googleMapsUri: 'https://maps.google.com/?q=2',
            },
          ],
        }),
      }),
    );

    const result = await searchPlacesText({
      apiKey: 'token',
      query: 'coffee',
      maxResults: 5,
      minRating: 4.5,
      costTier: 'essentials',
    });

    expect(result).toEqual({
      query: 'coffee',
      requestedMaxResults: 5,
      returnedCount: 1,
      results: [
        {
          placeId: 'high-rated',
          name: 'Great Coffee',
          formattedAddress: '2 Main St',
          rating: 4.8,
          userRatingCount: 320,
          priceLevel: null,
          types: [],
          hours: [],
          websiteUri: null,
          nationalPhoneNumber: null,
          googleMapsUri: 'https://maps.google.com/?q=2',
        },
      ],
    });
  });

  it('builds nearby search results and trims review text from details output', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: 'place-123',
              displayName: { text: 'Lunch Spot' },
              formattedAddress: '123 Granville St',
              rating: 4.6,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'place-123',
          displayName: { text: 'Lunch Spot' },
          formattedAddress: '123 Granville St',
          currentOpeningHours: {
            openNow: true,
            weekdayDescriptions: ['Monday: 9:00 AM - 5:00 PM'],
          },
          editorialSummary: { text: 'Popular for quick lunches.' },
          reviews: [
            {
              rating: 5,
              relativePublishTimeDescription: '2 weeks ago',
              publishTime: '2026-04-01T12:00:00Z',
              text: { text: 'This should never leak into the response.' },
            },
          ],
        }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const nearby = await searchPlacesNearby({
      apiKey: 'token',
      latitude: 49.2827,
      longitude: -123.1207,
      radius: 500,
      type: 'restaurant',
      maxResults: 10,
      costTier: 'pro',
    });
    const details = await getPlaceDetails({
      apiKey: 'token',
      placeId: 'place-123',
    });

    expect(nearby).toEqual({
      center: {
        latitude: 49.2827,
        longitude: -123.1207,
      },
      radius: 500,
      returnedCount: 1,
      results: [
        {
          placeId: 'place-123',
          name: 'Lunch Spot',
          formattedAddress: '123 Granville St',
          rating: 4.6,
          userRatingCount: null,
          priceLevel: null,
          types: [],
          hours: [],
          websiteUri: null,
          nationalPhoneNumber: null,
          googleMapsUri: null,
        },
      ],
    });

    expect(details).toEqual({
      placeId: 'place-123',
      name: 'Lunch Spot',
      formattedAddress: '123 Granville St',
      rating: null,
      userRatingCount: null,
      priceLevel: null,
      types: [],
      regularHours: [],
      currentHours: {
        openNow: true,
        weekdayDescriptions: ['Monday: 9:00 AM - 5:00 PM'],
      },
      websiteUri: null,
      nationalPhoneNumber: null,
      googleMapsUri: null,
      editorialSummary: 'Popular for quick lunches.',
      reviewSummary: {
        reviewCount: 1,
        reviews: [
          {
            rating: 5,
            relativePublishTimeDescription: '2 weeks ago',
            publishTime: '2026-04-01T12:00:00Z',
          },
        ],
      },
    });
  });
});

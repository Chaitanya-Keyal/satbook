-- Price caches are keyed only by period, so rows fetched from an Indian
-- exchange would keep shadowing the global-market convention the app now uses
-- everywhere. They are a pure cache: dropping them just triggers a refetch.
DELETE FROM `price_candles` WHERE `source` = 'coindcx';

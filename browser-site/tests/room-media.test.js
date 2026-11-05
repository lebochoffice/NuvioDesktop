import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoomTitle, resolveRoomMedia, searchRoomMedia} from '../src/room-media.js';

test('only a catalog-confirmed movie or exact series episode can create media', async () => {
  const id = 'tt1234567';
  const calls = [];
  const fetchMeta = async (url, init) => {
    calls.push({url, init});
    return {ok: true, json: async () => ({meta: {id, type: 'series', name: 'Confirmed series',
      videos: [{id: id + ':2:3', season: 2, episode: 3}]}})};
  };
  const media = await resolveRoomMedia('series', id, 2, 3, fetchMeta);
  assert.equal(media.meta_id, id);
  assert.equal(media.video_id, id + ':2:3');
  assert.equal(media.season, 2); assert.equal(media.episode, 3);
  assert.equal(calls[0].init.credentials, 'omit');
  await assert.rejects(resolveRoomMedia('series', id, 2, 4, fetchMeta), /Episode/);
  await assert.rejects(resolveRoomMedia('movie', 'placeholder', null, null, fetchMeta), /IMDb/);
  await assert.rejects(resolveRoomMedia('movie', id, null, null, fetchMeta), /Medienidentität/);
  await assert.rejects(resolveRoomMedia('movie', id, null, null, async () => ({ok: false})), /bestätigt/);
});

test('IMDb links use only their verified title ID and optional catalog metadata', async () => {
  const id = 'tt1234567';
  const poster = 'https://art.example.test/poster.jpg';
  const fetchMeta = async url => {
    assert.equal(url, 'https://v3-cinemeta.strem.io/meta/movie/' + id + '.json');
    return {ok: true, json: async () => ({meta: {id, type: 'movie', name: 'Movie', description: 'Synopsis', poster}})};
  };
  const media = await resolveRoomMedia('movie', 'https://www.imdb.com/title/' + id + '/', null, null, fetchMeta);
  assert.deepEqual(media, {type: 'movie', meta_type: 'movie', meta_id: id, title: 'Movie', description: 'Synopsis', poster});
  const noFetch = () => assert.fail('invalid links must never trigger a catalog request');
  for (const input of ['', 'http://www.imdb.com/title/' + id, 'https://www.imdb.com.example.test/title/' + id]) {
    await assert.rejects(resolveRoomMedia('movie', input, null, null, noFetch), /IMDb/);
  }
});

test('a title query searches both Cinemeta catalogs and filters invalid identities', async () => {
  const calls = [];
  const results = await searchRoomMedia('Film & Serie', async (url, init) => {
    calls.push(url);
    assert.equal(init.credentials, 'omit');
    const type = url.includes('/movie/') ? 'movie' : 'series';
    return {ok: true, json: async () => ({metas: [
      {id: 'bad-id', type, name: 'Invalid'},
      {id: type === 'movie' ? 'tt1234567' : 'tt7654321', type, name: 'Confirmed', releaseInfo: '2020–2022'},
    ]})};
  });
  assert.deepEqual(calls, ['movie', 'series'].map(type => `https://v3-cinemeta.strem.io/catalog/${type}/top/search=Film%20%26%20Serie.json`));
  assert.deepEqual(results.map(({id, type, year}) => [id, type, year]), [
    ['tt1234567', 'movie', '2020'], ['tt7654321', 'series', '2020'],
  ]);
  assert.deepEqual(await searchRoomMedia('missing', async () => ({ok: true, json: async () => ({metas: []})})), []);
  await assert.rejects(searchRoomMedia('bad', async () => ({ok: false})), /Titelsuche/);
  await assert.rejects(loadRoomTitle('movie', 'tt1234567', async () => ({ok: true, json: async () => ({})})), /Medienidentität/);
});

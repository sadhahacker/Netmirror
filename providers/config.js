const PROVIDERS = {
  netflix: {
    id: 'netflix',
    name: 'Netflix Mirror',
    pathPrefix: '',
    ott: 'nf',
    studio: null,
  },
  prime: {
    id: 'prime',
    name: 'Prime Video Mirror',
    pathPrefix: 'pv/',
    ott: 'pv',
    studio: null,
  },
  hotstar: {
    id: 'hotstar',
    name: 'Hotstar Mirror',
    pathPrefix: 'hs/',
    ott: 'hs',
    studio: null,
  },
  disney: {
    id: 'disney',
    name: 'Disney+',
    pathPrefix: 'hs/',
    ott: 'dp',
    studio: 'disney',
  },
  marvel: {
    id: 'marvel',
    name: 'Marvel',
    pathPrefix: 'hs/',
    ott: 'dp',
    studio: 'marvel',
  },
  starwars: {
    id: 'starwars',
    name: 'Star Wars',
    pathPrefix: 'hs/',
    ott: 'dp',
    studio: 'starwars',
  },
  pixar: {
    id: 'pixar',
    name: 'Pixar',
    pathPrefix: 'hs/',
    ott: 'dp',
    studio: 'pixar',
  },
};

module.exports = PROVIDERS;

#!/usr/bin/env node

const cheerio = require('cheerio');
const fs = require('fs');
const parseArgs = require('minimist');
const { pipeline } = require('stream/promises');
const { CookieJar } = require('tough-cookie');
const fetchCookie = require('fetch-cookie').default;

const jar = new CookieJar();
const fetchWithCookies = fetchCookie(fetch, jar);
const userAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// Print help/usage information
function usage(exitCode) {
  console.log(
    'Usage:\nnode download_album.js [OPTIONS] ALBUM_URL\n\n' +
      'Valid options are:\n' +
      '-h|--help\tGet this message\n' +
      '-d|--debug\tPrint stack trace on error\n' +
      '-s NUMBER\tNumber of tracks to be downloaded simultaneously (default: 5)\n' +
      '-t NUMBER\tDownload specific track number (useful if some track failed to download)'
  );
  process.exit(exitCode);
}

// Parse command-line arguments
const argv = parseArgs(process.argv.slice(2), {
  alias: {
    help: 'h',
    debug: 'd',
    sim: 's',
    trackID: 't'
  },

  default: {
    help: false,
    debug: false,
    sim: 5,
    trackID: false
  },

  boolean: ['help', 'debug'],

  stopEarly: true,

  // Reject unknown command-line options
  unknown: key => {
    if (!key.startsWith('-')) return;
    console.log(`Unknown key: ${key}
`);
    usage(1);
  }
});

// Validate/process command-line arguments
function processArgs(argv) {
  if (argv.help) usage(0);
  if (typeof argv.sim !== 'number') usage(1);

  const albumURL = argv._[0];
  const domain = new URL(albumURL).hostname;
  const parallelDownloads = argv.sim;
  const isDebugMode = argv.debug;
  const trackID = argv.trackID;

  return {
    albumURL,
    domain,
    parallelDownloads,
    isDebugMode,
    trackID
  };
}

// Fetch text/HTML from a URL
async function fetchText(url, headers = {}) {
  const response = await fetchWithCookies(url, {
    headers: {
      'User-Agent': userAgent,
      ...headers
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response.text();
}

// Fetch JSON from a URL
async function fetchJSON(url, headers = {}) {
  const response = await fetchWithCookies(url, {
    headers: {
      'User-Agent': userAgent,
      ...headers
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response.json();
}

// Parse the album page and extract:
// - album metadata
// - cover image URL
// - track names
// - stream URLs from the API
async function getLinksAndTags(html, domain) {
  const $ = cheerio.load(html);
  const tracksData = [];
  // Extract album artist/title from the page heading
  const [albumTitle, albumArtist = 'VA'] = $('h1')
    .text()
    .trim()
    .split(' - ', 2)
    .reverse();
  // All track elements in the playlist
  const $tracks = $('.playlist__item');
  // Album cover image URL
  const coverURL = $('.album-img').attr('src');

  // Iterate through all tracks
  for (const element of $tracks.toArray()) {
    let trackNo = $(element)
      .find('.tracklist__position-number')
      .text()
      .trim();

    // Pad track numbers to two digits
    if (trackNo.length < 2) {
      trackNo = '0' + trackNo;
    }

    // Musify pages store a track ID in HTML
    const trackID = $(element).attr('data-track-id');

    if (!trackID) {
      console.log('Could not find track ID');
      continue;
    }

    try {
      // Query Musify API to get the real MP3 stream URL
      const apiResponse = await fetchJSON(
        `https://${domain}/api/track/${trackID}/stream-url`,
        {
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `https://${domain}/`
        }
      );

      const streamURL = apiResponse.url;

      if (!streamURL) {
        console.log(`No stream URL for track ${trackID}`);
        continue;
      }

      // Store metadata for later downloading
      tracksData.push({
        url: streamURL,
        albumArtist,
        albumTitle,
        trackNo,
        trackArtist: $(element)
          .find('.tracklist__artist a')
          .text()
          .trim(),
        trackTitle: $(element)
          .find('.tracklist__title a')
          .text()
          .trim()
      });
    } catch (err) {
      console.log(`Failed API request for track ${trackID}`);
    }
  }

  return { tracksData, coverURL };
}

// Run async operations in parallel with a fixed queue size
// Prevents downloading too many tracks simultaneously
function executeInChunks(callbackArgs, callback, queueSize = 5) {
  const execWith = async (element, index) => {
    try {
      await callback(element);
    } catch (error) {
      console.warn('Download of: ', element, ' FAILED with error: ', error);
    }

    return index;
  };

  // Form initial queue consisting of promises, which resolve with
  // their index number in the queue array.
  const queueArray = callbackArgs.splice(0, queueSize).map(execWith);

  // Recursively get rid of resolved promises in the queue.
  // Add new promises preventing queue from emptying.
  const keepQueueSize = async () => {
    if (callbackArgs.length) {
      try {
        const index = await Promise.race(queueArray);

        queueArray.splice(index, 1, execWith(callbackArgs.shift(), index));

        keepQueueSize();
      } catch (error) {
        console.error('Cannot assemble another chunk, error: ', error);
        throw error;
      }
    }
  };

  keepQueueSize();
}

// Remove invalid filename characters
function cleanUpSymbols(inputString) {
  return inputString.replace(/[:/\"*<>|?]/g, '');
}

// Download a file using fetch() streaming
async function downloadFile(url, filename) {
  const response = await fetchWithCookies(url, {
    headers: {
      'User-Agent': userAgent
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  // Stream download directly to disk without buffering entire file in RAM
  await pipeline(response.body, fs.createWriteStream(filename));
}

// Download one individual track
async function downloadTrack({ url, ...trackInfo }) {
  // Clean filenames
  Object.keys(trackInfo).forEach(prop => {
    trackInfo[prop] = cleanUpSymbols(trackInfo[prop]);
  });

  const {
    albumArtist,
    albumTitle,
    trackNo,
    trackArtist,
    trackTitle
  } = trackInfo;

  const filename = `${albumArtist}/${albumTitle}/${trackNo}. ${trackArtist} - ${trackTitle}.mp3`;

  console.log(`Starting download: ${trackNo} - ${trackTitle}`);

  try {
    await downloadFile(url, filename);
    console.log(`Download is finished: ${trackNo} - ${trackTitle}`);
  } catch (error) {
    console.log(`Download is failed: ${trackNo} - ${trackTitle}`);
    throw error;
  }
}

// Create album directory structure
async function prepareAlbumDir(tracksData) {
  const albumArtist = cleanUpSymbols(tracksData[0].albumArtist);
  const albumTitle = cleanUpSymbols(tracksData[0].albumTitle);

  const albumDir = `${albumArtist}/${albumTitle}`;

  // recursive:true creates parent directories automatically
  await fs.promises.mkdir(albumDir, {
    recursive: true
  });

  return albumDir;
}

// Download album cover image
async function downloadCover(coverURL, albumDir) {
  const filename = `${albumDir}/cover.jpg`;

  try {
    await downloadFile(coverURL, filename);
    console.log('Cover is downloaded');
  } catch (error) {
    console.log('Failed to download cover');
  }
}

// Main program entry point
(async () => {
  const {
    albumURL,
    domain,
    parallelDownloads,
    isDebugMode,
    trackID
  } = processArgs(argv);

  try {
    // Download album page HTML
    const body = await fetchText(albumURL);

    // Extract track information and cover URL
    const { tracksData, coverURL } = await getLinksAndTags(body, domain);

    if (!tracksData.length) {
      throw new Error('No tracks found');
    }

    // Create target album directory
    const albumDir = await prepareAlbumDir(tracksData);

    // Download only one track if requested
    if (trackID) {
      executeInChunks(
        tracksData.slice(trackID - 1, trackID),
        downloadTrack,
        1
      );

      return;
    }

    // Download album cover
    if (coverURL) {
      await downloadCover(coverURL, albumDir);
    }

    // Download tracks in parallel
    await executeInChunks(
      tracksData,
      downloadTrack,
      parallelDownloads
    );
  } catch (error) {
    console.log(`Failed to download the album: ${error}`);

    if (isDebugMode) {
      console.log(error.stack);
    }
  }
})();

import 'dotenv/config';
import fs from 'fs';
import express from 'express';
import { google } from 'googleapis';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// CONFIG
// =====================================================

const railwayBase = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : null;

const cfg = {
  port: Number(process.env.PORT || 3000),

  base:
    process.env.BASE_URL ||
    railwayBase ||
    'http://localhost:3000',

  handle:
    process.env.YOUTUBE_CHANNEL_HANDLE ||
    '@KindCrafted-m4q',

  phrase:
    process.env.VERIFY_PHRASE ||
    'CRAFTED-MANAGER-VERIFY-2026',

  clientId:
    process.env.GOOGLE_CLIENT_ID,

  clientSecret:
    process.env.GOOGLE_CLIENT_SECRET,

  redirectUri:
    process.env.GOOGLE_REDIRECT_URI ||
    `${
      process.env.BASE_URL ||
      railwayBase ||
      'http://localhost:3000'
    }/oauth2callback`,

  geminiKey:
    process.env.GEMINI_API_KEY,

  // Optional override.
  // If this is blank, the app automatically finds
  // a currently available Gemini generateContent model.
  geminiModel:
    process.env.GEMINI_MODEL || '',

  postsPerDay: Math.max(
    1,
    Math.min(
      5,
      Number(process.env.POSTS_PER_DAY || 2)
    )
  ),

  tz:
    process.env.TIMEZONE ||
    'Pacific/Honolulu',

  // How many recent PUBLIC videos should influence
  // posting-time recommendations.
  recentVideoLimit: Math.max(
    5,
    Number(
      process.env.RECENT_VIDEO_LIMIT || 30
    )
  ),

  // Don't schedule too close to the current time.
  scheduleBufferMinutes: Math.max(
    30,
    Number(
      process.env.SCHEDULE_BUFFER_MINUTES || 60
    )
  )
};

// =====================================================
// DATABASE
// =====================================================

const dataDir = path.join(
  __dirname,
  'data'
);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(
    dataDir,
    {
      recursive: true
    }
  );
}

const databasePath = path.join(
  dataDir,
  'creator.db'
);

console.log(
  `[database] Opening database at ${databasePath}`
);

const db =
  new Database(databasePath);

db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handled_comments (
  comment_id TEXT PRIMARY KEY,
  action TEXT,
  reply TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS questions (
  comment_id TEXT PRIMARY KEY,
  author TEXT,
  text TEXT,
  video_id TEXT,
  video_title TEXT,
  created_at TEXT,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS performance (
  video_id TEXT,
  sampled_at TEXT,
  views INTEGER,
  likes INTEGER,
  comments INTEGER
);
`);

console.log(
  '[database] Database ready'
);

const getKV = (key) =>
  db
    .prepare(
      'SELECT v FROM kv WHERE k=?'
    )
    .get(key)?.v;

const setKV = (key, value) =>
  db
    .prepare(`
      INSERT INTO kv(k,v)
      VALUES(?,?)
      ON CONFLICT(k)
      DO UPDATE SET v=excluded.v
    `)
    .run(
      key,
      String(value)
    );

// =====================================================
// GOOGLE OAUTH
// =====================================================

function oauth() {
  return new google.auth.OAuth2(
    cfg.clientId,
    cfg.clientSecret,
    cfg.redirectUri
  );
}

function authed() {
  const o = oauth();

  const raw =
    getKV('tokens');

  if (!raw) {
    throw new Error(
      'YouTube not connected'
    );
  }

  const credentials =
    JSON.parse(raw);

  o.setCredentials(
    credentials
  );

  o.on(
    'tokens',
    (tokens) => {
      const existing =
        JSON.parse(
          getKV('tokens') ||
          '{}'
        );

      setKV(
        'tokens',
        JSON.stringify({
          ...existing,
          ...tokens
        })
      );
    }
  );

  return o;
}

function yt() {
  return google.youtube({
    version: 'v3',
    auth: authed()
  });
}

// =====================================================
// GOOGLE LOGIN
// =====================================================

app.get(
  '/auth/google',
  (req, res) => {
    if (
      !cfg.clientId ||
      !cfg.clientSecret
    ) {
      return res
        .status(500)
        .send(
          'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.'
        );
    }

    const o = oauth();

    const authUrl =
      o.generateAuthUrl({
        access_type:
          'offline',

        prompt:
          'consent',

        scope: [
          'https://www.googleapis.com/auth/youtube.force-ssl',
          'https://www.googleapis.com/auth/youtube.readonly'
        ]
      });

    res.redirect(
      authUrl
    );
  }
);

app.get(
  '/oauth2callback',
  async (req, res) => {
    try {
      if (
        !req.query.code
      ) {
        throw new Error(
          'Google did not return an authorization code.'
        );
      }

      const o = oauth();

      const { tokens } =
        await o.getToken(
          req.query.code
        );

      setKV(
        'tokens',
        JSON.stringify(tokens)
      );

      console.log(
        '[oauth] YouTube connected'
      );

      res.redirect(
        '/?connected=1'
      );
    } catch (error) {
      console.error(
        '[oauth]',
        error
      );

      res
        .status(500)
        .send(
          `YouTube connection failed: ${error.message}`
        );
    }
  }
);

// =====================================================
// YOUTUBE CHANNEL
// =====================================================

async function channelInfo() {
  const response =
    await yt().channels.list({
      part: [
        'snippet',
        'statistics',
        'contentDetails'
      ],

      mine: true
    });

  const channel =
    response.data.items?.[0];

  if (!channel) {
    throw new Error(
      'No authorized YouTube channel found'
    );
  }

  return channel;
}

async function verifyDescription() {
  const channel =
    await channelInfo();

  const description =
    channel.snippet?.description ||
    '';

  return {
    ok:
      description.includes(
        cfg.phrase
      ),

    channel
  };
}

// =====================================================
// LOAD ALL CHANNEL VIDEOS
// =====================================================

async function allOwnedVideos() {
  const channel =
    await channelInfo();

  const uploads =
    channel
      .contentDetails
      .relatedPlaylists
      .uploads;

  let pageToken;

  const ids = [];

  do {
    const response =
      await yt()
        .playlistItems
        .list({
          part: [
            'contentDetails'
          ],

          playlistId:
            uploads,

          maxResults:
            50,

          pageToken
        });

    ids.push(
      ...(
        response.data.items ||
        []
      )
        .map(
          (item) =>
            item
              .contentDetails
              .videoId
        )
        .filter(Boolean)
    );

    pageToken =
      response
        .data
        .nextPageToken;

  } while (pageToken);

  const videos = [];

  for (
    let i = 0;
    i < ids.length;
    i += 50
  ) {
    const response =
      await yt()
        .videos
        .list({
          part: [
            'snippet',
            'status',
            'statistics',
            'contentDetails'
          ],

          id:
            ids.slice(
              i,
              i + 50
            )
        });

    videos.push(
      ...(
        response.data.items ||
        []
      )
    );
  }

  return videos;
}

// =====================================================
// HELPERS
// =====================================================

function numeric(
  value
) {
  const n =
    Number(value || 0);

  return Number.isFinite(n)
    ? n
    : 0;
}

function ageHours(
  iso
) {
  if (!iso) {
    return 1;
  }

  return Math.max(
    1,
    (
      Date.now() -
      new Date(iso)
        .getTime()
    ) / 36e5
  );
}

function ageDays(
  iso
) {
  return (
    ageHours(iso) /
    24
  );
}

// =====================================================
// RECENT VIDEO PERFORMANCE SCORE
// =====================================================

function rawPerformanceScore(
  video
) {
  const hours =
    ageHours(
      video
        .snippet
        ?.publishedAt
    );

  const views =
    numeric(
      video
        .statistics
        ?.viewCount
    );

  const likes =
    numeric(
      video
        .statistics
        ?.likeCount
    );

  const comments =
    numeric(
      video
        .statistics
        ?.commentCount
    );

  /*
   * Performance is normalized by age so a very old
   * video doesn't automatically beat a newer upload
   * just because it has accumulated more total views.
   */
  const viewVelocity =
    views /
    Math.max(
      6,
      hours
    );

  const likeVelocity =
    likes /
    Math.max(
      6,
      hours
    );

  const commentVelocity =
    comments /
    Math.max(
      6,
      hours
    );

  return (
    viewVelocity +
    likeVelocity * 4 +
    commentVelocity * 8
  );
}

function recencyWeight(
  video
) {
  const days =
    Math.max(
      0,
      ageDays(
        video
          .snippet
          ?.publishedAt
      )
    );

  /*
   * Recent uploads matter more.
   *
   * Today      ~ 1.00
   * 7 days     ~ 0.77
   * 30 days    ~ 0.37
   * 60 days    ~ 0.14
   */
  return Math.exp(
    -days / 30
  );
}

function weightedVideoScore(
  video
) {
  return (
    rawPerformanceScore(
      video
    ) *
    recencyWeight(
      video
    )
  );
}

// =====================================================
// HAWAII / LOCAL TIME HELPERS
// =====================================================

function localParts(
  date
) {
  const formatter =
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone:
          cfg.tz,

        year:
          'numeric',

        month:
          '2-digit',

        day:
          '2-digit',

        hour:
          '2-digit',

        minute:
          '2-digit',

        hourCycle:
          'h23'
      }
    );

  return Object.fromEntries(
    formatter
      .formatToParts(
        date
      )
      .filter(
        (part) =>
          part.type !==
          'literal'
      )
      .map(
        (part) => [
          part.type,
          part.value
        ]
      )
  );
}

function localMinuteOfDay(
  iso
) {
  const parts =
    localParts(
      new Date(iso)
    );

  return (
    Number(parts.hour) *
      60 +
    Number(parts.minute)
  );
}

function circularMinuteDistance(
  a,
  b
) {
  const difference =
    Math.abs(a - b);

  return Math.min(
    difference,
    1440 - difference
  );
}

// =====================================================
// CALCULATE BEST POSTING TIMES
// =====================================================

function bestPostingTimes(
  videos
) {
  /*
   * Only PUBLIC videos can teach us when successful
   * publishing happened.
   *
   * Newest videos are selected first.
   */
  const recentPublic =
    videos
      .filter(
        (video) =>
          video.status
            ?.privacyStatus ===
            'public' &&
          video.snippet
            ?.publishedAt
      )
      .sort(
        (a, b) =>
          new Date(
            b.snippet
              .publishedAt
          ) -
          new Date(
            a.snippet
              .publishedAt
          )
      )
      .slice(
        0,
        cfg.recentVideoLimit
      );

  /*
   * If there isn't enough history yet, use sensible
   * temporary slots. These disappear once enough
   * channel data exists.
   */
  if (
    recentPublic.length ===
    0
  ) {
    return [
      {
        minuteOfDay:
          12 * 60,
        score:
          0,
        samples:
          0,
        fallback:
          true
      },
      {
        minuteOfDay:
          18 * 60,
        score:
          0,
        samples:
          0,
        fallback:
          true
      }
    ].slice(
      0,
      cfg.postsPerDay
    );
  }

  /*
   * Group videos into 30-minute posting windows.
   *
   * Example:
   * 4:12 PM -> 4:00 PM bucket
   * 4:44 PM -> 4:30 PM bucket
   */
  const buckets =
    new Map();

  for (
    const video of
      recentPublic
  ) {
    const minute =
      localMinuteOfDay(
        video
          .snippet
          .publishedAt
      );

    const bucket =
      Math.round(
        minute / 30
      ) * 30 %
      1440;

    const score =
      weightedVideoScore(
        video
      );

    const existing =
      buckets.get(
        bucket
      ) || {
        totalScore:
          0,

        totalWeight:
          0,

        samples:
          0
      };

    const weight =
      recencyWeight(
        video
      );

    existing.totalScore +=
      score;

    existing.totalWeight +=
      weight;

    existing.samples++;

    buckets.set(
      bucket,
      existing
    );
  }

  const ranked =
    [...buckets]
      .map(
        ([
          minuteOfDay,
          info
        ]) => ({
          minuteOfDay,

          /*
           * Weighted average + small confidence bonus
           * for slots supported by multiple videos.
           */
          score:
            (
              info.totalScore /
              Math.max(
                0.01,
                info.totalWeight
              )
            ) *
            (
              1 +
              Math.min(
                0.25,
                (
                  info.samples -
                  1
                ) *
                0.05
              )
            ),

          samples:
            info.samples,

          fallback:
            false
        })
      )
      .sort(
        (a, b) =>
          b.score -
          a.score
      );

  const selected =
    [];

  /*
   * Don't choose two posting times that are almost
   * identical. Aim for at least 3 hours apart.
   */
  for (
    const candidate of
      ranked
  ) {
    const farEnough =
      selected.every(
        (chosen) =>
          circularMinuteDistance(
            chosen.minuteOfDay,
            candidate.minuteOfDay
          ) >=
          180
      );

    if (farEnough) {
      selected.push(
        candidate
      );
    }

    if (
      selected.length >=
      cfg.postsPerDay
    ) {
      break;
    }
  }

  /*
   * If channel history doesn't provide enough
   * separated times, use the next strongest buckets.
   */
  if (
    selected.length <
    cfg.postsPerDay
  ) {
    for (
      const candidate of
        ranked
    ) {
      if (
        selected.some(
          (chosen) =>
            chosen.minuteOfDay ===
            candidate.minuteOfDay
        )
      ) {
        continue;
      }

      selected.push(
        candidate
      );

      if (
        selected.length >=
        cfg.postsPerDay
      ) {
        break;
      }
    }
  }

  /*
   * Very small channels may only have one historical
   * posting time. Add temporary fallback slots.
   */
  const fallbackMinutes = [
    12 * 60,
    18 * 60,
    9 * 60,
    21 * 60
  ];

  for (
    const minute of
      fallbackMinutes
  ) {
    if (
      selected.length >=
      cfg.postsPerDay
    ) {
      break;
    }

    if (
      selected.every(
        (chosen) =>
          circularMinuteDistance(
            chosen.minuteOfDay,
            minute
          ) >=
          180
      )
    ) {
      selected.push({
        minuteOfDay:
          minute,

        score:
          0,

        samples:
          0,

        fallback:
          true
      });
    }
  }

  return selected
    .slice(
      0,
      cfg.postsPerDay
    )
    .sort(
      (a, b) =>
        a.minuteOfDay -
        b.minuteOfDay
    );
}

// =====================================================
// BACKWARD COMPATIBILITY FOR DASHBOARD
// =====================================================

function bestHours(
  videos
) {
  /*
   * Your current HTML dashboard expects an array
   * of numeric hours.
   *
   * We keep that response working while also exposing
   * detailed recommendedTimes below.
   */
  return bestPostingTimes(
    videos
  ).map(
    (slot) =>
      Number(
        (
          slot.minuteOfDay /
          60
        ).toFixed(2)
      )
  );
}

function recommendedTimesForApi(
  videos
) {
  return bestPostingTimes(
    videos
  ).map(
    (slot) => {
      const hour =
        Math.floor(
          slot.minuteOfDay /
          60
        );

      const minute =
        slot.minuteOfDay %
        60;

      return {
        hour,
        minute,
        minuteOfDay:
          slot.minuteOfDay,
        score:
          Number(
            slot.score.toFixed(
              3
            )
          ),
        samples:
          slot.samples,
        fallback:
          slot.fallback
      };
    }
  );
}

// =====================================================
// TIME ZONE OFFSET
// =====================================================

function timezoneOffsetMs(
  date,
  timeZone
) {
  const parts =
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone,
        year:
          'numeric',
        month:
          '2-digit',
        day:
          '2-digit',
        hour:
          '2-digit',
        minute:
          '2-digit',
        second:
          '2-digit',
        hourCycle:
          'h23'
      }
    )
      .formatToParts(
        date
      );

  const values =
    Object.fromEntries(
      parts
        .filter(
          (part) =>
            part.type !==
            'literal'
        )
        .map(
          (part) => [
            part.type,
            part.value
          ]
        )
    );

  const asUTC =
    Date.UTC(
      Number(
        values.year
      ),
      Number(
        values.month
      ) - 1,
      Number(
        values.day
      ),
      Number(
        values.hour
      ),
      Number(
        values.minute
      ),
      Number(
        values.second
      )
    );

  return (
    asUTC -
    date.getTime()
  );
}

function zonedDateToUtc(
  year,
  month,
  day,
  hour,
  minute,
  timeZone
) {
  /*
   * Start by pretending the requested local time is UTC,
   * determine the zone offset, then correct it.
   */
  let guess =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        0,
        0
      )
    );

  let offset =
    timezoneOffsetMs(
      guess,
      timeZone
    );

  let result =
    new Date(
      guess.getTime() -
      offset
    );

  /*
   * Recalculate once to handle DST/time-zone transitions
   * correctly for zones other than Hawaii too.
   */
  offset =
    timezoneOffsetMs(
      result,
      timeZone
    );

  result =
    new Date(
      guess.getTime() -
      offset
    );

  return result;
}

// =====================================================
// DATE HELPERS
// =====================================================

function localDateForDayOffset(
  dayOffset
) {
  /*
   * Use noon to avoid edge cases around date boundaries.
   */
  const base =
    new Date(
      Date.now() +
      dayOffset *
        86400000
    );

  const parts =
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone:
          cfg.tz,

        year:
          'numeric',

        month:
          '2-digit',

        day:
          '2-digit'
      }
    )
      .formatToParts(
        base
      );

  const values =
    Object.fromEntries(
      parts
        .filter(
          (part) =>
            part.type !==
            'literal'
        )
        .map(
          (part) => [
            part.type,
            part.value
          ]
        )
    );

  return {
    year:
      Number(
        values.year
      ),

    month:
      Number(
        values.month
      ),

    day:
      Number(
        values.day
      )
  };
}

// =====================================================
// NEXT POSTING SLOTS
// =====================================================

function nextSlots(
  postingTimes,
  count
) {
  const slots =
    [];

  const earliestAllowed =
    Date.now() +
    cfg.scheduleBufferMinutes *
      60 *
      1000;

  /*
   * Search up to 180 days ahead.
   */
  for (
    let dayOffset = 0;
    dayOffset < 180 &&
    slots.length < count;
    dayOffset++
  ) {
    const date =
      localDateForDayOffset(
        dayOffset
      );

    for (
      const postingTime of
        postingTimes
    ) {
      const minuteOfDay =
        typeof postingTime ===
        'number'
          ? Math.round(
              postingTime *
              60
            )
          : postingTime
              .minuteOfDay;

      const hour =
        Math.floor(
          minuteOfDay /
          60
        );

      const minute =
        minuteOfDay %
        60;

      const slot =
        zonedDateToUtc(
          date.year,
          date.month,
          date.day,
          hour,
          minute,
          cfg.tz
        );

      /*
       * Never submit an already-passed or near-current
       * publish time to YouTube.
       */
      if (
        slot.getTime() >
        earliestAllowed
      ) {
        slots.push(
          slot
        );
      }

      if (
        slots.length >=
        count
      ) {
        break;
      }
    }
  }

  return slots
    .sort(
      (a, b) =>
        a.getTime() -
        b.getTime()
    )
    .slice(
      0,
      count
    );
}

// =====================================================
// SAFE VIDEO STATUS UPDATE
// =====================================================

function buildScheduledStatus(
  video,
  publishAt
) {
  /*
   * videos.update replaces mutable values in the
   * specified "status" part, so preserve status fields
   * we already know rather than unnecessarily wiping
   * them.
   */

  const status = {
    privacyStatus:
      'private',

    publishAt:
      publishAt.toISOString()
  };

  if (
    typeof video.status
      ?.selfDeclaredMadeForKids ===
    'boolean'
  ) {
    status.selfDeclaredMadeForKids =
      video.status
        .selfDeclaredMadeForKids;
  }

  if (
    typeof video.status
      ?.embeddable ===
    'boolean'
  ) {
    status.embeddable =
      video.status
        .embeddable;
  }

  if (
    video.status
      ?.license
  ) {
    status.license =
      video.status
        .license;
  }

  if (
    typeof video.status
      ?.publicStatsViewable ===
    'boolean'
  ) {
    status.publicStatsViewable =
      video.status
        .publicStatsViewable;
  }

  if (
    typeof video.status
      ?.containsSyntheticMedia ===
    'boolean'
  ) {
    status.containsSyntheticMedia =
      video.status
        .containsSyntheticMedia;
  }

  return status;
}

// =====================================================
// AUTO-SCHEDULE PRIVATE VIDEOS
// =====================================================

async function schedulePrivateVideos() {
  const verified =
    await verifyDescription();

  if (!verified.ok) {
    return {
      scheduled: 0,

      reason:
        'Verification phrase not found in channel description'
    };
  }

  const videos =
    await allOwnedVideos();

  const postingTimes =
    bestPostingTimes(
      videos
    );

  /*
   * Only processed, private, currently-unscheduled
   * videos are candidates.
   */
  const privateVideos =
    videos
      .filter(
        (video) =>
          video.status
            ?.privacyStatus ===
            'private' &&

          !video.status
            ?.publishAt &&

          video.status
            ?.uploadStatus ===
            'processed'
      )
      .sort(
        (a, b) =>
          new Date(
            a.snippet
              ?.publishedAt ||
            0
          ) -
          new Date(
            b.snippet
              ?.publishedAt ||
            0
          )
      );

  if (
    privateVideos.length ===
    0
  ) {
    return {
      scheduled:
        0,

      postingTimes:
        recommendedTimesForApi(
          videos
        ),

      hours:
        bestHours(
          videos
        ),

      message:
        'No unscheduled private videos found.'
    };
  }

  /*
   * Generate extra slots in case YouTube rejects a
   * specific video because it was previously public.
   */
  const slots =
    nextSlots(
      postingTimes,
      privateVideos.length +
        10
    );

  let scheduled =
    0;

  let slotIndex =
    0;

  const results =
    [];

  const errors =
    [];

  for (
    const video of
      privateVideos
  ) {
    if (
      slotIndex >=
      slots.length
    ) {
      break;
    }

    let success =
      false;

    /*
     * Usually one attempt is enough.
     * If YouTube rejects the time itself, try the next
     * calculated future slot.
     */
    for (
      let attempt = 0;
      attempt < 3 &&
      slotIndex < slots.length;
      attempt++
    ) {
      const slot =
        slots[
          slotIndex
        ];

      slotIndex++;

      /*
       * Extra safety check immediately before API call.
       */
      if (
        slot.getTime() <=
        Date.now() +
          cfg.scheduleBufferMinutes *
            60 *
            1000
      ) {
        continue;
      }

      try {
        await yt()
          .videos
          .update({
            part: [
              'status'
            ],

            requestBody: {
              id:
                video.id,

              status:
                buildScheduledStatus(
                  video,
                  slot
                )
            }
          });

        scheduled++;

        success =
          true;

        results.push({
          id:
            video.id,

          title:
            video.snippet
              ?.title ||
            video.id,

          publishAt:
            slot
              .toISOString()
        });

        console.log(
          `[schedule] Scheduled "${video.snippet?.title}" for ${slot.toISOString()}`
        );

        break;

      } catch (error) {
        const reason =
          error.response
            ?.data
            ?.error
            ?.errors?.[0]
            ?.reason ||
          '';

        const message =
          error.response
            ?.data
            ?.error
            ?.message ||
          error.message;

        console.error(
          `[schedule] ${video.id}: ${reason || 'error'} - ${message}`
        );

        /*
         * invalidPublishAt:
         * try a later calculated slot.
         */
        if (
          reason ===
          'invalidPublishAt'
        ) {
          continue;
        }

        /*
         * Other errors are likely tied to the video
         * itself, authorization, or channel settings.
         */
        errors.push({
          id:
            video.id,

          title:
            video.snippet
              ?.title ||
            video.id,

          reason:
            reason ||
            'unknown',

          message
        });

        break;
      }
    }

    if (!success) {
      /*
       * Continue to the next private video instead of
       * crashing the entire scheduling batch.
       */
      continue;
    }
  }

  return {
    scheduled,

    attempted:
      privateVideos.length,

    postingTimes:
      recommendedTimesForApi(
        videos
      ),

    /*
     * Kept for compatibility with your current
     * dashboard.
     */
    hours:
      bestHours(
        videos
      ),

    scheduledVideos:
      results,

    errors
  };
}

// =====================================================
// GEMINI MODEL DISCOVERY
// =====================================================

let cachedGeminiModel =
  null;

let cachedGeminiModelAt =
  0;

async function discoverGeminiModel() {
  if (
    cfg.geminiModel
  ) {
    return cfg.geminiModel
      .replace(
        /^models\//,
        ''
      );
  }

  /*
   * Keep the discovered model cached for six hours.
   */
  if (
    cachedGeminiModel &&
    Date.now() -
      cachedGeminiModelAt <
      6 *
        60 *
        60 *
        1000
  ) {
    return cachedGeminiModel;
  }

  if (!cfg.geminiKey) {
    throw new Error(
      'GEMINI_API_KEY missing'
    );
  }

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models' +
    `?key=${encodeURIComponent(
      cfg.geminiKey
    )}`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Gemini model lookup failed (${response.status}): ${await response.text()}`
    );
  }

  const data =
    await response.json();

  const models =
    (
      data.models ||
      []
    )
      .filter(
        (model) =>
          (
            model
              .supportedGenerationMethods ||
            []
          )
            .includes(
              'generateContent'
            )
      );

  /*
   * Prefer Flash models because comment moderation
   * and short replies don't require the slowest/
   * most expensive reasoning model.
   */
  const preferred =
    models.find(
      (model) =>
        /flash/i.test(
          model.name
        ) &&
        !/lite/i.test(
          model.name
        )
    ) ||
    models.find(
      (model) =>
        /flash/i.test(
          model.name
        )
    ) ||
    models[0];

  if (!preferred) {
    throw new Error(
      'No Gemini generateContent model is available for this API key.'
    );
  }

  cachedGeminiModel =
    preferred.name
      .replace(
        /^models\//,
        ''
      );

  cachedGeminiModelAt =
    Date.now();

  console.log(
    `[gemini] Using model ${cachedGeminiModel}`
  );

  return cachedGeminiModel;
}

// =====================================================
// GEMINI
// =====================================================

async function gemini(
  prompt
) {
  if (!cfg.geminiKey) {
    throw new Error(
      'GEMINI_API_KEY missing'
    );
  }

  const model =
    await discoverGeminiModel();

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(
      model
    )}:generateContent?key=` +
    encodeURIComponent(
      cfg.geminiKey
    );

  const response =
    await fetch(
      url,
      {
        method:
          'POST',

        headers: {
          'content-type':
            'application/json'
        },

        body:
          JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text:
                      prompt
                  }
                ]
              }
            ],

            generationConfig: {
              temperature:
                0.4
            }
          })
      }
    );

  if (!response.ok) {
    /*
     * If Google removed the cached model, clear it so
     * the next request discovers a currently available
     * model.
     */
    if (
      response.status ===
      404
    ) {
      cachedGeminiModel =
        null;

      cachedGeminiModelAt =
        0;
    }

    throw new Error(
      `Gemini ${response.status}: ${await response.text()}`
    );
  }

  const data =
    await response.json();

  const text =
    data
      .candidates?.[0]
      ?.content
      ?.parts
      ?.map(
        (part) =>
          part.text ||
          ''
      )
      .join('')
      .trim();

  if (!text) {
    throw new Error(
      'Gemini returned an empty response.'
    );
  }

  return text;
}

// =====================================================
// COMMENTS
// =====================================================

async function classifyAndReply() {
  const verified =
    await verifyDescription();

  if (!verified.ok) {
    return {
      handled: 0,

      reason:
        'Not verified'
    };
  }

  const response =
    await yt()
      .commentThreads
      .list({
        part: [
          'snippet'
        ],

        allThreadsRelatedToChannelId:
          verified.channel.id,

        maxResults:
          50,

        order:
          'time'
      });

  let handled =
    0;

  for (
    const thread of
      response.data.items ||
      []
  ) {
    const comment =
      thread
        .snippet
        .topLevelComment;

    if (!comment) {
      continue;
    }

    const id =
      comment.id;

    const alreadyHandled =
      db
        .prepare(`
          SELECT 1
          FROM handled_comments
          WHERE comment_id=?
        `)
        .get(id);

    if (
      alreadyHandled
    ) {
      continue;
    }

    const snippet =
      comment.snippet;

    /*
     * Ignore comments posted by your own channel.
     */
    if (
      snippet
        .authorChannelId
        ?.value ===
      verified.channel.id
    ) {
      db
        .prepare(`
          INSERT OR IGNORE INTO handled_comments
          (comment_id, action)
          VALUES (?,?)
        `)
        .run(
          id,
          'own'
        );

      continue;
    }

    const commentText =
      snippet.textOriginal ||
      snippet.textDisplay ||
      '';

    const verdict =
      (
        await gemini(`
Classify this YouTube comment.

Return ONLY one of these words:

QUESTION
SPAM
NORMAL

QUESTION:
The viewer is asking KindCrafted for information,
help, an explanation, an opinion, or a response.

SPAM:
Obvious spam, scams, repetitive advertising,
malicious promotion, or meaningless bot content.

NORMAL:
A normal friendly comment, compliment, reaction,
statement, or non-question.

Comment:
${JSON.stringify(
  commentText
)}
        `)
      )
        .trim()
        .toUpperCase();

    if (
      verdict.includes(
        'QUESTION'
      )
    ) {
      db
        .prepare(`
          INSERT OR IGNORE INTO questions
          (
            comment_id,
            author,
            text,
            video_id,
            video_title,
            created_at
          )
          VALUES (?,?,?,?,?,?)
        `)
        .run(
          id,

          snippet
            .authorDisplayName ||
            'Unknown',

          commentText,

          thread
            .snippet
            .videoId,

          '',

          snippet
            .publishedAt
        );

      db
        .prepare(`
          INSERT OR IGNORE INTO handled_comments
          (comment_id, action)
          VALUES (?,?)
        `)
        .run(
          id,
          'question'
        );

    } else if (
      verdict.includes(
        'SPAM'
      )
    ) {
      /*
       * This marks the comment as spam internally.
       * It does NOT delete the viewer's comment.
       */
      db
        .prepare(`
          INSERT OR IGNORE INTO handled_comments
          (comment_id, action)
          VALUES (?,?)
        `)
        .run(
          id,
          'spam'
        );

    } else {
      const reply =
        await gemini(`
Write one short, friendly, positive,
family-friendly YouTube reply as KindCrafted.

Rules:
- Keep it natural.
- Keep it short.
- Do not invent information.
- Do not ask the viewer a question.
- Do not mention AI.
- Do not claim something happened if the comment
  does not establish it.
- Avoid sounding repetitive or robotic.

Viewer comment:
${JSON.stringify(
  commentText
)}
        `);

      await yt()
        .comments
        .insert({
          part: [
            'snippet'
          ],

          requestBody: {
            snippet: {
              parentId:
                id,

              textOriginal:
                reply
            }
          }
        });

      db
        .prepare(`
          INSERT OR IGNORE INTO handled_comments
          (
            comment_id,
            action,
            reply
          )
          VALUES (?,?,?)
        `)
        .run(
          id,
          'replied',
          reply
        );
    }

    handled++;
  }

  return {
    handled
  };
}

// =====================================================
// API STATUS
// =====================================================

app.get(
  '/api/status',
  async (req, res) => {
    try {
      const verified =
        await verifyDescription();

      const videos =
        await allOwnedVideos();

      const postingTimes =
        recommendedTimesForApi(
          videos
        );

      const privateQueue =
        videos
          .filter(
            (video) =>
              video.status
                ?.privacyStatus ===
                'private'
          )
          .sort(
            (a, b) =>
              new Date(
                a.snippet
                  ?.publishedAt ||
                0
              ) -
              new Date(
                b.snippet
                  ?.publishedAt ||
                0
              )
          )
          .map(
            (video) => ({
              id:
                video.id,

              title:
                video.snippet
                  ?.title ||
                video.id,

              publishAt:
                video.status
                  ?.publishAt ||
                null,

              uploadStatus:
                video.status
                  ?.uploadStatus ||
                null
            })
          );

      const questions =
        db
          .prepare(`
            SELECT *
            FROM questions
            WHERE status='pending'
            ORDER BY created_at DESC
          `)
          .all();

      const publicVideos =
        videos
          .filter(
            (video) =>
              video.status
                ?.privacyStatus ===
                'public'
          )
          .sort(
            (a, b) =>
              new Date(
                b.snippet
                  ?.publishedAt ||
                0
              ) -
              new Date(
                a.snippet
                  ?.publishedAt ||
                0
              )
          );

      res.json({
        connected:
          true,

        verified:
          verified.ok,

        verificationPhrase:
          cfg.phrase,

        channel: {
          id:
            verified
              .channel
              .id,

          title:
            verified
              .channel
              .snippet
              .title,

          stats:
            verified
              .channel
              .statistics
        },

        /*
         * Existing dashboard support.
         */
        bestHours:
          postingTimes.map(
            (slot) =>
              Number(
                (
                  slot.hour +
                  slot.minute /
                    60
                ).toFixed(
                  2
                )
              )
          ),

        /*
         * New detailed data for future dashboard
         * improvements.
         */
        recommendedTimes:
          postingTimes,

        recommendationSource: {
          recentVideosUsed:
            Math.min(
              publicVideos.length,
              cfg.recentVideoLimit
            ),

          maxRecentVideos:
            cfg.recentVideoLimit,

          postsPerDay:
            cfg.postsPerDay,

          timezone:
            cfg.tz
        },

        privateQueue,

        questions
      });

    } catch (error) {
      console.error(
        '[status]',
        error
      );

      res.json({
        connected:
          false,

        verified:
          false,

        error:
          error.message
      });
    }
  }
);

// =====================================================
// MANUAL SCHEDULE
// =====================================================

app.post(
  '/api/run/schedule',
  async (req, res) => {
    try {
      const result =
        await schedulePrivateVideos();

      res.json(
        result
      );

    } catch (error) {
      console.error(
        '[schedule]',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

// =====================================================
// MANUAL COMMENTS
// =====================================================

app.post(
  '/api/run/comments',
  async (req, res) => {
    try {
      const result =
        await classifyAndReply();

      res.json(
        result
      );

    } catch (error) {
      console.error(
        '[comments]',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

// =====================================================
// QUESTION REPLY
// =====================================================

app.post(
  '/api/questions/:id/reply',
  async (req, res) => {
    try {
      const question =
        db
          .prepare(`
            SELECT *
            FROM questions
            WHERE comment_id=?
          `)
          .get(
            req.params.id
          );

      if (!question) {
        return res
          .status(404)
          .json({
            error:
              'Question not found'
          });
      }

      const text =
        String(
          req.body.text ||
          ''
        ).trim();

      if (!text) {
        return res
          .status(400)
          .json({
            error:
              'Reply required'
          });
      }

      await yt()
        .comments
        .insert({
          part: [
            'snippet'
          ],

          requestBody: {
            snippet: {
              parentId:
                question.comment_id,

              textOriginal:
                text
            }
          }
        });

      db
        .prepare(`
          UPDATE questions
          SET status='replied'
          WHERE comment_id=?
        `)
        .run(
          question.comment_id
        );

      res.json({
        ok: true
      });

    } catch (error) {
      console.error(
        '[question reply]',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

// =====================================================
// IGNORE QUESTION
// =====================================================

app.post(
  '/api/questions/:id/ignore',
  (req, res) => {
    try {
      db
        .prepare(`
          UPDATE questions
          SET status='ignored'
          WHERE comment_id=?
        `)
        .run(
          req.params.id
        );

      res.json({
        ok: true
      });

    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok:
        true,

      service:
        'KindCrafted Creator Manager',

      timezone:
        cfg.tz,

      postsPerDay:
        cfg.postsPerDay
    });
  }
);

// =====================================================
// WEBSITE
// =====================================================

const publicDir =
  path.join(
    __dirname,
    'public'
  );

const indexFile =
  path.join(
    publicDir,
    'index.html'
  );

console.log(
  `[website] Public directory: ${publicDir}`
);

console.log(
  `[website] index.html exists: ${fs.existsSync(
    indexFile
  )}`
);

app.use(
  express.static(
    publicDir
  )
);

app.get(
  '/',
  (req, res) => {
    if (
      !fs.existsSync(
        indexFile
      )
    ) {
      return res
        .status(500)
        .send(`
          <h1>KindCrafted Creator Manager</h1>
          <p>Server is online, but public/index.html was not found.</p>
        `);
    }

    res.sendFile(
      indexFile
    );
  }
);

// =====================================================
// AUTOMATIC CYCLE
// =====================================================

let busy =
  false;

async function cycle() {
  if (busy) {
    return;
  }

  busy =
    true;

  try {
    if (
      getKV(
        'tokens'
      )
    ) {
      console.log(
        '[cycle] Starting'
      );

      try {
        const scheduleResult =
          await schedulePrivateVideos();

        console.log(
          '[cycle] Schedule:',
          JSON.stringify(
            scheduleResult
          )
        );

      } catch (error) {
        console.error(
          '[cycle:schedule]',
          error.message
        );
      }

      try {
        const commentResult =
          await classifyAndReply();

        console.log(
          '[cycle] Comments:',
          JSON.stringify(
            commentResult
          )
        );

      } catch (error) {
        console.error(
          '[cycle:comments]',
          error.message
        );
      }
    }

  } finally {
    busy =
      false;
  }
}

// Run every 10 minutes.
setInterval(
  cycle,
  10 *
    60 *
    1000
);

// First automatic run 15 seconds after startup.
setTimeout(
  cycle,
  15000
);

// =====================================================
// START SERVER
// =====================================================

app.listen(
  cfg.port,
  '0.0.0.0',
  () => {
    console.log(
      `KindCrafted Creator Manager running on ${cfg.port}`
    );

    console.log(
      `[server] Base URL: ${cfg.base}`
    );

    console.log(
      `[server] OAuth redirect: ${cfg.redirectUri}`
    );

    console.log(
      `[server] Dashboard: ${cfg.base}/`
    );

    console.log(
      `[scheduler] Timezone: ${cfg.tz}`
    );

    console.log(
      `[scheduler] Posts per day: ${cfg.postsPerDay}`
    );

    console.log(
      `[scheduler] Recent videos analyzed: up to ${cfg.recentVideoLimit}`
    );

    console.log(
      `[scheduler] Minimum future buffer: ${cfg.scheduleBufferMinutes} minutes`
    );
  }
);

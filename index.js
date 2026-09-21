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

  geminiModel:
    process.env.GEMINI_MODEL || '',

  timezone:
    process.env.TIMEZONE ||
    'Pacific/Honolulu',

  // Analyze videos from the previous 8 weeks.
  analyticsWeeks:
    Math.max(
      1,
      Number(
        process.env.ANALYTICS_WEEKS || 8
      )
    ),

  // Always schedule exactly two maximum.
  postsPerDay: 2,

  // Never schedule something only a few minutes away.
  scheduleBufferMinutes:
    Math.max(
      10,
      Number(
        process.env.SCHEDULE_BUFFER_MINUTES || 30
      )
    )
};

// =====================================================
// DATABASE
// =====================================================

const dataDir =
  path.join(
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

const databasePath =
  path.join(
    dataDir,
    'creator.db'
  );

console.log(
  `[database] Opening ${databasePath}`
);

const db =
  new Database(
    databasePath
  );

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

function getKV(key) {
  return db
    .prepare(
      'SELECT v FROM kv WHERE k=?'
    )
    .get(key)?.v;
}

function setKV(
  key,
  value
) {
  db.prepare(`
    INSERT INTO kv(k,v)
    VALUES(?,?)
    ON CONFLICT(k)
    DO UPDATE SET v=excluded.v
  `).run(
    key,
    String(value)
  );
}

function deleteKV(key) {
  db.prepare(
    'DELETE FROM kv WHERE k=?'
  ).run(key);
}

// =====================================================
// AUTOMATION STATE
// =====================================================

function automationEnabled() {
  return (
    getKV(
      'auto_post_enabled'
    ) === '1'
  );
}

function setAutomationEnabled(
  enabled
) {
  setKV(
    'auto_post_enabled',
    enabled ? '1' : '0'
  );
}

// =====================================================
// HAWAII DATE / TIME HELPERS
// =====================================================

function hawaiiParts(
  date = new Date()
) {
  const parts =
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone:
          cfg.timezone,

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
    ).formatToParts(
      date
    );

  const values =
    Object.fromEntries(
      parts
        .filter(
          part =>
            part.type !==
            'literal'
        )
        .map(
          part => [
            part.type,
            part.value
          ]
        )
    );

  return {
    year:
      Number(values.year),

    month:
      Number(values.month),

    day:
      Number(values.day),

    hour:
      Number(values.hour),

    minute:
      Number(values.minute),

    second:
      Number(values.second)
  };
}

function todayKey() {
  const date =
    hawaiiParts();

  return (
    `${date.year}-` +
    `${String(
      date.month
    ).padStart(
      2,
      '0'
    )}-` +
    `${String(
      date.day
    ).padStart(
      2,
      '0'
    )}`
  );
}

function dailyStateKey(
  dateKey = todayKey()
) {
  return (
    `daily_schedule_${dateKey}`
  );
}

function emptyDailyState(
  dateKey
) {
  return {
    date:
      dateKey,

    completed:
      false,

    calculatedAt:
      null,

    recommendedTimes:
      [],

    scheduledVideoIds:
      [],

    scheduled:
      []
  };
}

function getDailyState(
  dateKey = todayKey()
) {
  const raw =
    getKV(
      dailyStateKey(
        dateKey
      )
    );

  if (!raw) {
    return emptyDailyState(
      dateKey
    );
  }

  try {
    const parsed =
      JSON.parse(raw);

    return {
      date:
        dateKey,

      completed:
        Boolean(
          parsed.completed
        ),

      calculatedAt:
        parsed.calculatedAt ||
        null,

      recommendedTimes:
        Array.isArray(
          parsed.recommendedTimes
        )
          ? parsed.recommendedTimes
          : [],

      scheduledVideoIds:
        Array.isArray(
          parsed.scheduledVideoIds
        )
          ? parsed.scheduledVideoIds
          : [],

      scheduled:
        Array.isArray(
          parsed.scheduled
        )
          ? parsed.scheduled
          : []
    };

  } catch {
    return emptyDailyState(
      dateKey
    );
  }
}

function saveDailyState(
  state
) {
  setKV(
    dailyStateKey(
      state.date
    ),

    JSON.stringify(
      state
    )
  );
}

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
  const client =
    oauth();

  const raw =
    getKV(
      'tokens'
    );

  if (!raw) {
    throw new Error(
      'YouTube not connected'
    );
  }

  client.setCredentials(
    JSON.parse(raw)
  );

  client.on(
    'tokens',
    tokens => {
      const existing =
        JSON.parse(
          getKV(
            'tokens'
          ) || '{}'
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

  return client;
}

function yt() {
  return google.youtube({
    version:
      'v3',

    auth:
      authed()
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
          'Missing Google OAuth variables.'
        );
    }

    const client =
      oauth();

    const url =
      client.generateAuthUrl({
        access_type:
          'offline',

        prompt:
          'consent',

        scope: [
          'https://www.googleapis.com/auth/youtube.force-ssl',
          'https://www.googleapis.com/auth/youtube.readonly'
        ]
      });

    res.redirect(url);
  }
);

app.get(
  '/oauth2callback',
  async (
    req,
    res
  ) => {
    try {
      if (!req.query.code) {
        throw new Error(
          'Google did not return an authorization code.'
        );
      }

      const client =
        oauth();

      const {
        tokens
      } =
        await client.getToken(
          req.query.code
        );

      setKV(
        'tokens',
        JSON.stringify(
          tokens
        )
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
    await yt()
      .channels
      .list({
        part: [
          'snippet',
          'statistics',
          'contentDetails'
        ],

        mine:
          true
      });

  const channel =
    response
      .data
      .items?.[0];

  if (!channel) {
    throw new Error(
      'No authorized YouTube channel found.'
    );
  }

  return channel;
}

async function verifyDescription() {
  const channel =
    await channelInfo();

  const description =
    channel
      .snippet
      ?.description ||
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
// LOAD CHANNEL VIDEOS
// =====================================================

async function allOwnedVideos() {
  const channel =
    await channelInfo();

  const playlistId =
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

          playlistId,

          maxResults:
            50,

          pageToken
        });

    ids.push(
      ...(
        response
          .data
          .items ||
        []
      )
        .map(
          item =>
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

  } while (
    pageToken
  );

  const videos = [];

  for (
    let index = 0;
    index < ids.length;
    index += 50
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
              index,
              index + 50
            )
        });

    videos.push(
      ...(
        response
          .data
          .items ||
        []
      )
    );
  }

  return videos;
}

// =====================================================
// SAVE ANALYTICS SNAPSHOTS
// =====================================================

function numeric(value) {
  const number =
    Number(
      value || 0
    );

  return Number.isFinite(
    number
  )
    ? number
    : 0;
}

function savePerformanceSnapshots(
  videos
) {
  const insert =
    db.prepare(`
      INSERT INTO performance
      (
        video_id,
        sampled_at,
        views,
        likes,
        comments
      )
      VALUES (?,?,?,?,?)
    `);

  const now =
    new Date()
      .toISOString();

  const transaction =
    db.transaction(
      rows => {
        for (
          const video of
            rows
        ) {
          insert.run(
            video.id,

            now,

            numeric(
              video
                .statistics
                ?.viewCount
            ),

            numeric(
              video
                .statistics
                ?.likeCount
            ),

            numeric(
              video
                .statistics
                ?.commentCount
            )
          );
        }
      }
    );

  const publicVideos =
    videos.filter(
      video =>
        video
          .status
          ?.privacyStatus ===
        'public'
    );

  transaction(
    publicVideos
  );

  // Remove snapshots older than 90 days.
  db.prepare(`
    DELETE FROM performance
    WHERE sampled_at < datetime('now', '-90 days')
  `).run();
}

// =====================================================
// ANALYTICS WINDOW
// =====================================================

function analyticsCutoff() {
  return (
    Date.now() -
    cfg.analyticsWeeks *
      7 *
      24 *
      60 *
      60 *
      1000
  );
}

function videosForAnalytics(
  videos
) {
  const cutoff =
    analyticsCutoff();

  return videos
    .filter(
      video =>
        video
          .status
          ?.privacyStatus ===
          'public' &&

        video
          .snippet
          ?.publishedAt &&

        new Date(
          video
            .snippet
            .publishedAt
        ).getTime() >=
        cutoff
    )
    .sort(
      (a, b) =>
        new Date(
          b
            .snippet
            .publishedAt
        ) -
        new Date(
          a
            .snippet
            .publishedAt
        )
    );
}

// =====================================================
// VIDEO PERFORMANCE
// =====================================================

function ageHours(
  publishedAt
) {
  if (!publishedAt) {
    return 1;
  }

  return Math.max(
    1,

    (
      Date.now() -
      new Date(
        publishedAt
      ).getTime()
    ) /
    3600000
  );
}

function ageDays(
  publishedAt
) {
  return (
    ageHours(
      publishedAt
    ) /
    24
  );
}

function recencyWeight(
  video
) {
  const days =
    ageDays(
      video
        .snippet
        ?.publishedAt
    );

  // Recent videos matter more,
  // but older videos from the selected
  // analytics window still count.
  return Math.max(
    0.25,
    Math.exp(
      -days / 35
    )
  );
}

function engagementScore(
  video
) {
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

  const hours =
    Math.max(
      12,

      ageHours(
        video
          .snippet
          ?.publishedAt
      )
    );

  const viewVelocity =
    views /
    hours;

  const likeVelocity =
    likes /
    hours;

  const commentVelocity =
    comments /
    hours;

  const engagementRate =
    views > 0
      ? (
          likes * 2 +
          comments * 4
        ) /
        views
      : 0;

  const score =
    viewVelocity +

    likeVelocity *
      5 +

    commentVelocity *
      10 +

    engagementRate *
      100;

  return (
    score *
    recencyWeight(
      video
    )
  );
}

// =====================================================
// SNAPSHOT PERFORMANCE BOOST
// =====================================================

function snapshotGrowthScore(
  videoId
) {
  const rows =
    db.prepare(`
      SELECT
        sampled_at,
        views,
        likes,
        comments
      FROM performance
      WHERE video_id=?
      ORDER BY sampled_at ASC
    `).all(
      videoId
    );

  if (
    rows.length <
    2
  ) {
    return 0;
  }

  const first =
    rows[0];

  const last =
    rows[
      rows.length - 1
    ];

  const start =
    new Date(
      first.sampled_at
    ).getTime();

  const end =
    new Date(
      last.sampled_at
    ).getTime();

  const hours =
    Math.max(
      1,
      (
        end -
        start
      ) /
      3600000
    );

  const views =
    Math.max(
      0,
      numeric(
        last.views
      ) -
      numeric(
        first.views
      )
    );

  const likes =
    Math.max(
      0,
      numeric(
        last.likes
      ) -
      numeric(
        first.likes
      )
    );

  const comments =
    Math.max(
      0,
      numeric(
        last.comments
      ) -
      numeric(
        first.comments
      )
    );

  return (
    views /
      hours +

    likes *
      5 /
      hours +

    comments *
      10 /
      hours
  );
}

function finalPerformanceScore(
  video
) {
  const lifetime =
    engagementScore(
      video
    );

  const recentGrowth =
    snapshotGrowthScore(
      video.id
    );

  // Current video performance is the base.
  // Snapshot growth adds extra evidence as
  // the app gathers data throughout the week.
  return (
    lifetime +
    recentGrowth *
      1.5
  );
}

// =====================================================
// LOCAL VIDEO POSTING TIME
// =====================================================

function localTimeParts(
  date
) {
  const parts =
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone:
          cfg.timezone,

        hour:
          '2-digit',

        minute:
          '2-digit',

        hourCycle:
          'h23'
      }
    ).formatToParts(
      date
    );

  const values =
    Object.fromEntries(
      parts
        .filter(
          part =>
            part.type !==
            'literal'
        )
        .map(
          part => [
            part.type,
            part.value
          ]
        )
    );

  return {
    hour:
      Number(
        values.hour
      ),

    minute:
      Number(
        values.minute
      )
  };
}

function localMinuteOfDay(
  publishedAt
) {
  const local =
    localTimeParts(
      new Date(
        publishedAt
      )
    );

  return (
    local.hour *
      60 +
    local.minute
  );
}

function circularDistance(
  a,
  b
) {
  const difference =
    Math.abs(
      a - b
    );

  return Math.min(
    difference,
    1440 -
      difference
  );
}

// =====================================================
// CALCULATE BEST POSTING TIMES
// =====================================================

function calculateBestPostingTimes(
  videos
) {
  const analyticsVideos =
    videosForAnalytics(
      videos
    );

  console.log(
    `[analytics] Analyzing ${analyticsVideos.length} public videos from the past ${cfg.analyticsWeeks} week(s).`
  );

  // Used only if there is not enough
  // historical evidence yet.
  const fallbackTimes = [
    10 * 60,
    17 * 60,
    13 * 60,
    20 * 60
  ];

  if (
    analyticsVideos.length ===
    0
  ) {
    return fallbackTimes
      .slice(
        0,
        2
      )
      .map(
        minuteOfDay => ({
          minuteOfDay,

          score:
            0,

          samples:
            0,

          fallback:
            true
        })
      );
  }

  const buckets =
    new Map();

  for (
    const video of
      analyticsVideos
  ) {
    const originalMinute =
      localMinuteOfDay(
        video
          .snippet
          .publishedAt
      );

    // Group videos into 30-minute posting windows.
    const minuteOfDay =
      (
        Math.round(
          originalMinute /
          30
        ) *
        30
      ) %
      1440;

    const score =
      finalPerformanceScore(
        video
      );

    const current =
      buckets.get(
        minuteOfDay
      ) || {
        totalScore:
          0,

        samples:
          0
      };

    current.totalScore +=
      score;

    current.samples++;

    buckets.set(
      minuteOfDay,
      current
    );
  }

  const ranked =
    [
      ...buckets.entries()
    ]
      .map(
        ([
          minuteOfDay,
          data
        ]) => {
          // Slightly reward time slots
          // that have multiple successful examples.
          const confidence =
            1 +
            Math.min(
              data.samples,
              5
            ) *
              0.05;

          return {
            minuteOfDay,

            score:
              (
                data.totalScore /
                Math.max(
                  1,
                  data.samples
                )
              ) *
              confidence,

            samples:
              data.samples,

            fallback:
              false
          };
        }
      )
      .sort(
        (a, b) =>
          b.score -
          a.score
      );

  const selected =
    [];

  for (
    const candidate of
      ranked
  ) {
    const farEnough =
      selected.every(
        existing =>
          circularDistance(
            existing.minuteOfDay,
            candidate.minuteOfDay
          ) >=
          180
      );

    if (
      farEnough
    ) {
      selected.push(
        candidate
      );
    }

    if (
      selected.length >=
      2
    ) {
      break;
    }
  }

  // If historical data only produced
  // one usable time, add a fallback.
  for (
    const minuteOfDay of
      fallbackTimes
  ) {
    if (
      selected.length >=
      2
    ) {
      break;
    }

    const farEnough =
      selected.every(
        existing =>
          circularDistance(
            existing.minuteOfDay,
            minuteOfDay
          ) >=
          180
      );

    if (
      farEnough
    ) {
      selected.push({
        minuteOfDay,

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
      2
    )
    .sort(
      (a, b) =>
        a.minuteOfDay -
        b.minuteOfDay
    );
}

// =====================================================
// TIME DISPLAY
// =====================================================

function displayTime(
  minuteOfDay
) {
  const hour24 =
    Math.floor(
      minuteOfDay /
      60
    );

  const minute =
    minuteOfDay %
    60;

  const hour12 =
    hour24 % 12 ===
    0
      ? 12
      : hour24 % 12;

  const suffix =
    hour24 >= 12
      ? 'PM'
      : 'AM';

  return (
    `${hour12}:` +
    `${String(
      minute
    ).padStart(
      2,
      '0'
    )} ` +
    suffix
  );
}

function recommendedTimesForApi(
  videos
) {
  return calculateBestPostingTimes(
    videos
  ).map(
    time => ({
      hour:
        Math.floor(
          time.minuteOfDay /
          60
        ),

      minute:
        time.minuteOfDay %
        60,

      minuteOfDay:
        time.minuteOfDay,

      display:
        displayTime(
          time.minuteOfDay
        ),

      score:
        Number(
          time.score.toFixed(
            3
          )
        ),

      samples:
        time.samples,

      fallback:
        time.fallback
    })
  );
}

// =====================================================
// TIMEZONE CONVERSION
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
    ).formatToParts(
      date
    );

  const values =
    Object.fromEntries(
      parts
        .filter(
          part =>
            part.type !==
            'literal'
        )
        .map(
          part => [
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

function localDateTimeToUTC(
  year,
  month,
  day,
  hour,
  minute
) {
  const guess =
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
      cfg.timezone
    );

  let result =
    new Date(
      guess.getTime() -
      offset
    );

  offset =
    timezoneOffsetMs(
      result,
      cfg.timezone
    );

  result =
    new Date(
      guess.getTime() -
      offset
    );

  return result;
}

// =====================================================
// TODAY'S TWO SLOTS
// =====================================================

function todaySlots(
  postingTimes,
  allowPassedTimes = false
) {
  const today =
    hawaiiParts();

  const minimumTime =
    Date.now() +
    cfg.scheduleBufferMinutes *
      60000;

  return postingTimes
    .map(
      time => {
        const hour =
          Math.floor(
            time.minuteOfDay /
            60
          );

        const minute =
          time.minuteOfDay %
          60;

        return localDateTimeToUTC(
          today.year,
          today.month,
          today.day,
          hour,
          minute
        );
      }
    )
    .filter(
      date =>
        allowPassedTimes ||
        date.getTime() >
          minimumTime
    )
    .sort(
      (a, b) =>
        a.getTime() -
        b.getTime()
    );
}

// =====================================================
// VIDEO STATUS
// =====================================================

function scheduledStatus(
  video,
  publishAt
) {
  const status = {
    privacyStatus:
      'private',

    publishAt:
      publishAt.toISOString()
  };

  if (
    typeof video
      .status
      ?.selfDeclaredMadeForKids ===
    'boolean'
  ) {
    status.selfDeclaredMadeForKids =
      video
        .status
        .selfDeclaredMadeForKids;
  }

  return status;
}

function privateStatus(
  video
) {
  const status = {
    privacyStatus:
      'private'
  };

  if (
    typeof video
      .status
      ?.selfDeclaredMadeForKids ===
    'boolean'
  ) {
    status.selfDeclaredMadeForKids =
      video
        .status
        .selfDeclaredMadeForKids;
  }

  return status;
}

// =====================================================
// DAILY AUTOMATIC SCHEDULER
// =====================================================

async function scheduleTodayOnly() {
  if (
    !automationEnabled()
  ) {
    return {
      enabled:
        false,

      scheduled:
        0,

      reason:
        'Automatic posting is stopped.'
    };
  }

  const verified =
    await verifyDescription();

  if (
    !verified.ok
  ) {
    return {
      enabled:
        true,

      scheduled:
        0,

      reason:
        'Verification phrase not found in channel description.'
    };
  }

  const dateKey =
    todayKey();

  const existingState =
    getDailyState(
      dateKey
    );

  // Prevent the 10-minute loop from
  // scheduling another pair later today.
  if (
    existingState.completed
  ) {
    return {
      enabled:
        true,

      date:
        dateKey,

      scheduled:
        0,

      alreadyCompleted:
        true,

      recommendedTimes:
        existingState
          .recommendedTimes,

      today:
        existingState
          .scheduled
    };
  }

  console.log(
    `[daily] Beginning analytics calculation for ${dateKey}`
  );

  const videos =
    await allOwnedVideos();

  // Save another analytics snapshot.
  savePerformanceSnapshots(
    videos
  );

  // Fresh calculation every Hawaii day.
  const postingTimes =
    calculateBestPostingTimes(
      videos
    );

  const recommendedTimes =
    postingTimes.map(
      time => ({
        hour:
          Math.floor(
            time.minuteOfDay /
            60
          ),

        minute:
          time.minuteOfDay %
          60,

        minuteOfDay:
          time.minuteOfDay,

        display:
          displayTime(
            time.minuteOfDay
          ),

        score:
          Number(
            time.score.toFixed(
              3
            )
          ),

        samples:
          time.samples,

        fallback:
          time.fallback
      })
    );

  console.log(
    '[daily] Recommended times:',
    recommendedTimes
      .map(
        time =>
          `${time.display} HST`
      )
      .join(', ')
  );

  const slots =
    todaySlots(
      postingTimes
    );

  const state =
    emptyDailyState(
      dateKey
    );

  state.calculatedAt =
    new Date()
      .toISOString();

  state.recommendedTimes =
    recommendedTimes;

  // If Railway was offline for too long and
  // both calculated times already passed,
  // don't schedule tomorrow early.
  // Tomorrow gets its own calculation.
  if (
    slots.length ===
    0
  ) {
    state.completed =
      true;

    saveDailyState(
      state
    );

    return {
      enabled:
        true,

      date:
        dateKey,

      scheduled:
        0,

      completed:
        true,

      recommendedTimes,

      reason:
        'Today’s calculated posting times have already passed. New times will be calculated at the next Hawaii day.'
    };
  }

  const waiting =
    videos
      .filter(
        video =>
          video
            .status
            ?.privacyStatus ===
            'private' &&

          !video
            .status
            ?.publishAt &&

          video
            .status
            ?.uploadStatus ===
            'processed'
      )
      .sort(
        (a, b) =>
          new Date(
            a
              .snippet
              ?.publishedAt ||
            0
          ) -
          new Date(
            b
              .snippet
              ?.publishedAt ||
            0
          )
      )
      .slice(
        0,
        Math.min(
          2,
          slots.length
        )
      );

  if (
    waiting.length ===
    0
  ) {
    // Do NOT mark completed.
    // This lets the system notice a newly
    // uploaded private video later today.
    saveDailyState(
      state
    );

    return {
      enabled:
        true,

      date:
        dateKey,

      scheduled:
        0,

      recommendedTimes,

      reason:
        'No unscheduled private videos are currently waiting.'
    };
  }

  const errors =
    [];

  for (
    let index = 0;
    index < waiting.length;
    index++
  ) {
    if (
      !automationEnabled()
    ) {
      break;
    }

    const video =
      waiting[index];

    const publishAt =
      slots[index];

    if (!publishAt) {
      break;
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
              scheduledStatus(
                video,
                publishAt
              )
          }
        });

      const scheduledVideo = {
        id:
          video.id,

        title:
          video
            .snippet
            ?.title ||
          video.id,

        publishAt:
          publishAt
            .toISOString(),

        displayTime:
          recommendedTimes[
            index
          ]?.display ||
          null
      };

      state
        .scheduledVideoIds
        .push(
          video.id
        );

      state
        .scheduled
        .push(
          scheduledVideo
        );

      saveDailyState(
        state
      );

      console.log(
        `[daily] Scheduled "${scheduledVideo.title}" for ${scheduledVideo.displayTime} HST`
      );

    } catch (error) {
      const reason =
        error
          .response
          ?.data
          ?.error
          ?.errors?.[0]
          ?.reason ||
        'unknown';

      const message =
        error
          .response
          ?.data
          ?.error
          ?.message ||
        error.message;

      console.error(
        '[daily:schedule]',
        video.id,
        reason,
        message
      );

      errors.push({
        id:
          video.id,

        title:
          video
            .snippet
            ?.title ||
          video.id,

        reason,

        message
      });
    }
  }

  // Once this daily run has assigned its
  // available pair, it must not schedule
  // another pair until tomorrow.
  state.completed =
    true;

  saveDailyState(
    state
  );

  return {
    enabled:
      true,

    date:
      dateKey,

    scheduled:
      state
        .scheduled
        .length,

    completed:
      true,

    analyticsWeeks:
      cfg.analyticsWeeks,

    videosAnalyzed:
      videosForAnalytics(
        videos
      ).length,

    recommendedTimes,

    scheduledVideos:
      state.scheduled,

    errors
  };
}

// =====================================================
// STOP / CANCEL TODAY'S FUTURE SCHEDULES
// =====================================================

async function cancelTodaysPending() {
  const dateKey =
    todayKey();

  const state =
    getDailyState(
      dateKey
    );

  if (
    state
      .scheduledVideoIds
      .length ===
    0
  ) {
    deleteKV(
      dailyStateKey(
        dateKey
      )
    );

    return {
      cancelled:
        0,

      cancelledVideos:
        []
    };
  }

  const videos =
    await allOwnedVideos();

  const videoMap =
    new Map(
      videos.map(
        video => [
          video.id,
          video
        ]
      )
    );

  const cancelled =
    [];

  for (
    const id of
      state
        .scheduledVideoIds
  ) {
    const video =
      videoMap.get(id);

    if (!video) {
      continue;
    }

    if (
      video
        .status
        ?.privacyStatus !==
      'private'
    ) {
      continue;
    }

    if (
      !video
        .status
        ?.publishAt
    ) {
      continue;
    }

    const publishAt =
      new Date(
        video
          .status
          .publishAt
      );

    if (
      publishAt.getTime() <=
      Date.now()
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
              privateStatus(
                video
              )
          }
        });

      cancelled.push({
        id:
          video.id,

        title:
          video
            .snippet
            ?.title ||
          video.id
      });

    } catch (error) {
      console.error(
        '[stop:cancel]',
        video.id,
        error.message
      );
    }
  }

  deleteKV(
    dailyStateKey(
      dateKey
    )
  );

  return {
    cancelled:
      cancelled.length,

    cancelledVideos:
      cancelled
  };
}

// =====================================================
// START AUTOMATION
// =====================================================

app.post(
  '/api/automation/start',
  async (
    req,
    res
  ) => {
    try {
      setAutomationEnabled(
        true
      );

      console.log(
        '[automation] STARTED'
      );

      // If today hasn't been handled yet,
      // calculate and schedule immediately.
      // Future days run automatically.
      const result =
        await scheduleTodayOnly();

      return res.json({
        ok:
          true,

        enabled:
          true,

        message:
          'Automatic posting started. Analytics will be recalculated every Hawaii day.',

        result
      });

    } catch (error) {
      console.error(
        '[automation:start]',
        error
      );

      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error.message
        });
    }
  }
);

// =====================================================
// STOP AUTOMATION
// =====================================================

app.post(
  '/api/automation/stop',
  async (
    req,
    res
  ) => {
    try {
      setAutomationEnabled(
        false
      );

      console.log(
        '[automation] STOPPED'
      );

      const result =
        await cancelTodaysPending();

      return res.json({
        ok:
          true,

        enabled:
          false,

        message:
          'Automatic posting stopped.',

        ...result
      });

    } catch (error) {
      console.error(
        '[automation:stop]',
        error
      );

      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error.message
        });
    }
  }
);

// =====================================================
// AUTOMATION STATUS
// =====================================================

app.get(
  '/api/automation',
  (
    req,
    res
  ) => {
    const date =
      todayKey();

    return res.json({
      ok:
        true,

      enabled:
        automationEnabled(),

      date,

      analyticsWeeks:
        cfg.analyticsWeeks,

      today:
        getDailyState(
          date
        )
    });
  }
);

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
    return cfg
      .geminiModel
      .replace(
        /^models\//,
        ''
      );
  }

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

  if (
    !cfg.geminiKey
  ) {
    throw new Error(
      'GEMINI_API_KEY missing'
    );
  }

  const response =
    await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models' +
      `?key=${encodeURIComponent(
        cfg.geminiKey
      )}`
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `Gemini model lookup failed: ${await response.text()}`
    );
  }

  const data =
    await response.json();

  const available =
    (
      data.models ||
      []
    ).filter(
      model =>
        (
          model
            .supportedGenerationMethods ||
          []
        ).includes(
          'generateContent'
        )
    );

  const preferred =
    available.find(
      model =>
        /flash/i.test(
          model.name
        ) &&
        !/lite/i.test(
          model.name
        )
    ) ||
    available.find(
      model =>
        /flash/i.test(
          model.name
        )
    ) ||
    available[0];

  if (!preferred) {
    throw new Error(
      'No compatible Gemini model found.'
    );
  }

  cachedGeminiModel =
    preferred
      .name
      .replace(
        /^models\//,
        ''
      );

  cachedGeminiModelAt =
    Date.now();

  console.log(
    `[gemini] Using ${cachedGeminiModel}`
  );

  return cachedGeminiModel;
}

async function gemini(
  prompt
) {
  if (
    !cfg.geminiKey
  ) {
    throw new Error(
      'GEMINI_API_KEY missing'
    );
  }

  const model =
    await discoverGeminiModel();

  const response =
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${encodeURIComponent(
        cfg.geminiKey
      )}`,

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
            ]
          })
      }
    );

  if (
    !response.ok
  ) {
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
        part =>
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
// COMMENT MANAGER
// =====================================================

async function classifyAndReply() {
  const verified =
    await verifyDescription();

  if (!verified.ok) {
    return {
      handled:
        0,

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
          verified
            .channel
            .id,

        maxResults:
          50,

        order:
          'time'
      });

  let handled =
    0;

  for (
    const thread of
      response
        .data
        .items ||
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

    const existing =
      db.prepare(`
        SELECT 1
        FROM handled_comments
        WHERE comment_id=?
      `).get(id);

    if (existing) {
      continue;
    }

    const snippet =
      comment.snippet;

    if (
      snippet
        .authorChannelId
        ?.value ===
      verified
        .channel
        .id
    ) {
      db.prepare(`
        INSERT OR IGNORE INTO handled_comments
        (comment_id, action)
        VALUES (?,?)
      `).run(
        id,
        'own'
      );

      continue;
    }

    const commentText =
      snippet
        .textOriginal ||
      snippet
        .textDisplay ||
      '';

    const verdict =
      (
        await gemini(`
Classify this YouTube comment.

Return ONLY one word:
QUESTION
SPAM
NORMAL

A question includes a request for information even without a question mark.

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
      db.prepare(`
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
      `).run(
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

      db.prepare(`
        INSERT OR IGNORE INTO handled_comments
        (comment_id, action)
        VALUES (?,?)
      `).run(
        id,
        'question'
      );

    } else if (
      verdict.includes(
        'SPAM'
      )
    ) {
      db.prepare(`
        INSERT OR IGNORE INTO handled_comments
        (comment_id, action)
        VALUES (?,?)
      `).run(
        id,
        'spam'
      );

    } else {
      const reply =
        await gemini(`
Write one short, friendly, positive, family-friendly YouTube reply as KindCrafted.

Do not ask a question.
Do not mention AI.
Do not invent facts.

Comment:
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

      db.prepare(`
        INSERT OR IGNORE INTO handled_comments
        (
          comment_id,
          action,
          reply
        )
        VALUES (?,?,?)
      `).run(
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
// STATUS API
// =====================================================

app.get(
  '/api/status',
  async (
    req,
    res
  ) => {
    try {
      const verified =
        await verifyDescription();

      const videos =
        await allOwnedVideos();

      const analyticsVideos =
        videosForAnalytics(
          videos
        );

      const recommendedTimes =
        recommendedTimesForApi(
          videos
        );

      const privateQueue =
        videos
          .filter(
            video =>
              video
                .status
                ?.privacyStatus ===
              'private'
          )
          .sort(
            (a, b) =>
              new Date(
                a
                  .snippet
                  ?.publishedAt ||
                0
              ) -
              new Date(
                b
                  .snippet
                  ?.publishedAt ||
                0
              )
          )
          .map(
            video => ({
              id:
                video.id,

              title:
                video
                  .snippet
                  ?.title ||
                video.id,

              publishAt:
                video
                  .status
                  ?.publishAt ||
                null
            })
          );

      const questions =
        db.prepare(`
          SELECT *
          FROM questions
          WHERE status='pending'
          ORDER BY created_at DESC
        `).all();

      const date =
        todayKey();

      return res.json({
        connected:
          true,

        verified:
          verified.ok,

        verificationPhrase:
          cfg.phrase,

        automation: {
          enabled:
            automationEnabled(),

          date,

          today:
            getDailyState(
              date
            )
        },

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

        recommendedTimes,

        // Keep this for older versions
        // of the dashboard too.
        bestHours:
          recommendedTimes.map(
            time =>
              time.hour +
              time.minute / 60
          ),

        recommendationSource: {
          analyticsWeeks:
            cfg.analyticsWeeks,

          videosAnalyzed:
            analyticsVideos.length,

          postsPerDay:
            2,

          timezone:
            cfg.timezone,

          method:
            'Historical public video performance'
        },

        privateQueue,

        questions
      });

    } catch (error) {
      console.error(
        '[api/status]',
        error
      );

      return res.json({
        connected:
          false,

        verified:
          false,

        automation: {
          enabled:
            automationEnabled()
        },

        error:
          error.message
      });
    }
  }
);

// =====================================================
// MANUAL SCHEDULE ENDPOINT
// =====================================================

// This does NOT schedule a week.
// It only performs today's daily run.
app.post(
  '/api/run/schedule',
  async (
    req,
    res
  ) => {
    try {
      if (
        !automationEnabled()
      ) {
        return res
          .status(409)
          .json({
            error:
              'Automatic posting is stopped. Press Start Automatic Posting first.'
          });
      }

      return res.json(
        await scheduleTodayOnly()
      );

    } catch (error) {
      console.error(
        '[manual:schedule]',
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

// =====================================================
// MANUAL COMMENT SCAN
// =====================================================

app.post(
  '/api/run/comments',
  async (
    req,
    res
  ) => {
    try {
      return res.json(
        await classifyAndReply()
      );

    } catch (error) {
      console.error(
        '[comments]',
        error
      );

      return res
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
  async (
    req,
    res
  ) => {
    try {
      const question =
        db.prepare(`
          SELECT *
          FROM questions
          WHERE comment_id=?
        `).get(
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
                question
                  .comment_id,

              textOriginal:
                text
            }
          }
        });

      db.prepare(`
        UPDATE questions
        SET status='replied'
        WHERE comment_id=?
      `).run(
        question
          .comment_id
      );

      return res.json({
        ok:
          true
      });

    } catch (error) {
      return res
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
  (
    req,
    res
  ) => {
    try {
      db.prepare(`
        UPDATE questions
        SET status='ignored'
        WHERE comment_id=?
      `).run(
        req.params.id
      );

      return res.json({
        ok:
          true
      });

    } catch (error) {
      return res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

// =====================================================
// HEALTH
// =====================================================

app.get(
  '/health',
  (
    req,
    res
  ) => {
    return res.json({
      ok:
        true,

      service:
        'KindCrafted Creator Manager',

      automaticPosting:
        automationEnabled(),

      timezone:
        cfg.timezone,

      analyticsWeeks:
        cfg.analyticsWeeks,

      postsPerDay:
        2
    });
  }
);

// =====================================================
// API 404
// =====================================================

app.use(
  '/api',
  (
    req,
    res
  ) => {
    return res
      .status(404)
      .json({
        ok:
          false,

        error:
          `API route not found: ${req.method} ${req.originalUrl}`
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
  (
    req,
    res
  ) => {
    if (
      !fs.existsSync(
        indexFile
      )
    ) {
      return res
        .status(500)
        .send(
          'public/index.html was not found.'
        );
    }

    return res.sendFile(
      indexFile
    );
  }
);

// =====================================================
// BACKGROUND AUTOMATION
// =====================================================

let cycleRunning =
  false;

let lastSnapshotHour =
  null;

async function cycle() {
  if (
    cycleRunning
  ) {
    return;
  }

  cycleRunning =
    true;

  try {
    if (
      !getKV(
        'tokens'
      )
    ) {
      return;
    }

    const now =
      hawaiiParts();

    console.log(
      `[cycle] Hawaii ${todayKey()} ${String(
        now.hour
      ).padStart(
        2,
        '0'
      )}:${String(
        now.minute
      ).padStart(
        2,
        '0'
      )}`
    );

    // =================================================
    // COLLECT ANALYTICS THROUGHOUT THE WEEK
    // =================================================

    // Take one snapshot per Hawaii hour.
    const snapshotHourKey =
      `${todayKey()}-${now.hour}`;

    if (
      snapshotHourKey !==
      lastSnapshotHour
    ) {
      try {
        const videos =
          await allOwnedVideos();

        savePerformanceSnapshots(
          videos
        );

        lastSnapshotHour =
          snapshotHourKey;

        console.log(
          '[analytics] Performance snapshot saved'
        );

      } catch (error) {
        console.error(
          '[analytics]',
          error.message
        );
      }
    }

    // =================================================
    // DAILY SCHEDULER
    // =================================================

    if (
      automationEnabled()
    ) {
      try {
        // scheduleTodayOnly has a daily database lock.
        // Therefore this can safely run every cycle.
        // At midnight/new day, today's lock doesn't exist,
        // so a fresh calculation occurs automatically.
        const result =
          await scheduleTodayOnly();

        console.log(
          '[cycle:schedule]',
          JSON.stringify(
            result
          )
        );

      } catch (error) {
        console.error(
          '[cycle:schedule]',
          error.message
        );
      }

    } else {
      console.log(
        '[cycle:schedule] Automatic posting stopped'
      );
    }

    // =================================================
    // COMMENTS
    // =================================================

    try {
      const result =
        await classifyAndReply();

      console.log(
        '[cycle:comments]',
        JSON.stringify(
          result
        )
      );

    } catch (error) {
      console.error(
        '[cycle:comments]',
        error.message
      );
    }

  } finally {
    cycleRunning =
      false;
  }
}

// Run every 10 minutes.
// This makes midnight scheduling reliable:
// the first cycle after 12:00 AM HST handles the new day.
setInterval(
  cycle,
  10 *
    60 *
    1000
);

// Also check shortly after Railway starts.
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
      '========================================'
    );

    console.log(
      'KindCrafted Creator Manager'
    );

    console.log(
      `Port: ${cfg.port}`
    );

    console.log(
      `Dashboard: ${cfg.base}/`
    );

    console.log(
      `OAuth redirect: ${cfg.redirectUri}`
    );

    console.log(
      `Timezone: ${cfg.timezone}`
    );

    console.log(
      `Analytics window: previous ${cfg.analyticsWeeks} weeks`
    );

    console.log(
      'Videos per day: 2'
    );

    console.log(
      'Scheduling: recalculated every Hawaii day'
    );

    console.log(
      'Future days: NOT pre-scheduled'
    );

    console.log(
      `Automatic posting: ${
        automationEnabled()
          ? 'RUNNING'
          : 'STOPPED'
      }`
    );

    console.log(
      '========================================'
    );
  }
);

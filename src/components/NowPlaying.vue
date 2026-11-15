<template>
  <div id="app">
    <div
      v-if="player.playing"
      class="now-playing"
      :class="getNowPlayingClass()"
      @click="showControls"
    >
      <div class="now-playing__cover">
        <img
          :src="player.trackAlbum.image"
          :alt="player.trackTitle"
          class="now-playing__image"
        />
      </div>
      <div class="now-playing__details">
        <h1 class="now-playing__track" v-text="player.trackTitle"></h1>
        <h2 class="now-playing__artists" v-text="getTrackArtists"></h2>

        <div
          class="now-playing__progress"
          :class="{ 'now-playing__progress--seekable': controlsVisible }"
          @click.stop="seekFromTap"
        >
          <div
            class="now-playing__progress-fill"
            :style="{ width: progressPercent + '%' }"
          ></div>
        </div>
        <p class="now-playing__time">
          <span v-text="formatTime(progressMs)"></span>
          <span v-text="formatTime(durationMs)"></span>
        </p>

        <div
          class="now-playing__controls"
          :class="{ 'now-playing__controls--visible': controlsVisible }"
        >
          <button
            class="now-playing__control"
            aria-label="Previous track"
            @click.stop="previousTrack"
          >
            &#9198;
          </button>
          <button
            class="now-playing__control now-playing__control--main"
            :aria-label="isPaused ? 'Play' : 'Pause'"
            @click.stop="togglePlay"
            v-html="isPaused ? '&#9654;' : '&#9208;'"
          ></button>
          <button
            class="now-playing__control"
            aria-label="Next track"
            @click.stop="nextTrack"
          >
            &#9197;
          </button>
        </div>
      </div>
    </div>
    <div v-else class="now-playing" :class="getNowPlayingClass()">
      <transition name="idle-fade">
        <img
          v-if="currentIdleImage"
          :key="currentIdleImage"
          :src="currentIdleImage"
          alt=""
          class="now-playing__idle-image"
        />
      </transition>
      <h1 v-if="!currentIdleImage" class="now-playing__idle-heading">
        No music is playing 😔
      </h1>
    </div>
  </div>
</template>

<script>
import * as Vibrant from 'node-vibrant'

import props from '@/utils/props.js'

/**
 * How long the controls stay on screen after a tap (ms).
 */
const CONTROLS_TIMEOUT = 5000

/**
 * How long each idle photo stays up before the next one (ms).
 */
const IDLE_ROTATE_MS = 60000

export default {
  name: 'NowPlaying',

  props: {
    auth: props.auth,
    endpoints: props.endpoints,
    player: props.player
  },

  data() {
    return {
      pollPlaying: '',
      playerResponse: {},
      playerData: this.getEmptyPlayer(),
      colourPalette: '',
      swatches: [],

      // Progress and controls
      progressMs: 0,
      durationMs: 0,
      isPaused: false,
      progressTick: '',
      controlsVisible: false,
      controlsTimer: '',

      // Idle photo rotation
      idleImages: [],
      idleIndex: 0,
      idleTimer: ''
    }
  },

  computed: {
    /**
     * Return a comma-separated list of track artists.
     * @return {String}
     */
    getTrackArtists() {
      return this.player.trackArtists.join(', ')
    },

    /**
     * How far through the song we are, 0–100.
     * @return {Number}
     */
    progressPercent() {
      if (!this.durationMs) {
        return 0
      }
      return Math.min(100, (this.progressMs / this.durationMs) * 100)
    },

    /**
     * The idle photo to show right now, or '' if there are none.
     * @return {String}
     */
    currentIdleImage() {
      return this.idleImages[this.idleIndex] || ''
    }
  },

  mounted() {
    this.setDataInterval()
    this.startProgressTick()
    this.loadIdleImages()
  },

  beforeDestroy() {
    clearInterval(this.pollPlaying)
    clearInterval(this.progressTick)
    clearTimeout(this.controlsTimer)
    clearInterval(this.idleTimer)
  },

  methods: {
    /**
     * Load the list of idle photos written at build time,
     * shuffle it, and start rotating.
     */
    async loadIdleImages() {
      try {
        const response = await fetch('/idle/list.json', { cache: 'no-store' })
        const images = response.ok ? await response.json() : []

        // Shuffle so each day starts somewhere different.
        for (let i = images.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[images[i], images[j]] = [images[j], images[i]]
        }

        this.idleImages = images
      } catch (error) {
        this.idleImages = []
      }

      clearInterval(this.idleTimer)
      this.idleTimer = setInterval(() => {
        if (!this.player.playing && this.idleImages.length > 1) {
          this.idleIndex = (this.idleIndex + 1) % this.idleImages.length
        }
      }, IDLE_ROTATE_MS)
    },

    /**
     * Make the network request to Spotify to
     * get the current played track.
     */
    async getNowPlaying() {
      let data = {}

      try {
        const response = await fetch(
          `${this.endpoints.base}/${this.endpoints.nowPlaying}`,
          {
            headers: {
              Authorization: `Bearer ${this.auth.accessToken}`
            }
          }
        )

        /**
         * Fetch error.
         */
        if (!response.ok) {
          throw new Error(`An error has occured: ${response.status}`)
        }

        /**
         * Spotify returns a 204 when no current device session is found.
         * The connection was successful but there's no content to return.
         */
        if (response.status === 204) {
          data = this.getEmptyPlayer()
          this.playerData = data

          this.$nextTick(() => {
            this.$emit('spotifyTrackUpdated', data)
          })

          return
        }

        data = await response.json()

        /**
         * Sync progress and play state on every poll, not just on
         * track change, so the bar stays accurate.
         */
        this.progressMs = data.progress_ms || 0
        this.durationMs = data.item?.duration_ms || 0
        this.isPaused = data.is_playing === false

        this.playerResponse = data
      } catch (error) {
        this.handleExpiredToken()

        data = this.getEmptyPlayer()
        this.playerData = data

        this.$nextTick(() => {
          this.$emit('spotifyTrackUpdated', data)
        })
      }
    },

    /**
     * Send a playback command to Spotify.
     * Requires the user-modify-playback-state scope and Spotify Premium.
     * @param {String} method - HTTP method (POST or PUT).
     * @param {String} path - path under /me/player.
     */
    async sendPlayerCommand(method, path) {
      try {
        const response = await fetch(
          `${this.endpoints.base}/me/player/${path}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${this.auth.accessToken}`
            }
          }
        )

        if (response.status === 401) {
          this.handleExpiredToken()
          return
        }

        if (!response.ok) {
          // 403 usually means the token lacks the new scope: log in again.
          // 404 means no active Spotify device.
          // eslint-disable-next-line no-console
          console.warn(`Player command failed: ${response.status}`)
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Player command error', error)
      }

      // Re-sync shortly after, rather than waiting for the next poll.
      setTimeout(() => this.getNowPlaying(), 400)
    },

    nextTrack() {
      this.showControls()
      this.sendPlayerCommand('POST', 'next')
    },

    previousTrack() {
      this.showControls()
      this.sendPlayerCommand('POST', 'previous')
    },

    togglePlay() {
      this.showControls()
      const command = this.isPaused ? 'play' : 'pause'
      this.isPaused = !this.isPaused // update the button immediately
      this.sendPlayerCommand('PUT', command)
    },

    /**
     * Jump to the tapped point on the progress bar.
     * Only works while the controls are showing, so a stray
     * touch on the bar can't skip you through a song.
     */
    seekFromTap(event) {
      if (!this.controlsVisible || !this.durationMs) {
        this.showControls()
        return
      }

      const bar = event.currentTarget.getBoundingClientRect()
      const fraction = Math.min(
        1,
        Math.max(0, (event.clientX - bar.left) / bar.width)
      )
      const positionMs = Math.round(fraction * this.durationMs)

      this.progressMs = positionMs
      this.showControls()
      this.sendPlayerCommand('PUT', `seek?position_ms=${positionMs}`)
    },

    /**
     * Show the controls, then hide them after CONTROLS_TIMEOUT.
     */
    showControls() {
      this.controlsVisible = true
      clearTimeout(this.controlsTimer)
      this.controlsTimer = setTimeout(() => {
        this.controlsVisible = false
      }, CONTROLS_TIMEOUT)
    },

    /**
     * Advance the progress bar once a second between polls,
     * so it slides smoothly instead of jumping every 2.5s.
     */
    startProgressTick() {
      clearInterval(this.progressTick)
      this.progressTick = setInterval(() => {
        if (!this.isPaused && this.durationMs) {
          this.progressMs = Math.min(this.progressMs + 1000, this.durationMs)
        }
      }, 1000)
    },

    /**
     * Turn milliseconds into m:ss.
     * @param {Number} ms
     * @return {String}
     */
    formatTime(ms) {
      const totalSeconds = Math.floor((ms || 0) / 1000)
      const minutes = Math.floor(totalSeconds / 60)
      const seconds = String(totalSeconds % 60).padStart(2, '0')
      return `${minutes}:${seconds}`
    },

    /**
     * Get the Now Playing element class.
     * @return {String}
     */
    getNowPlayingClass() {
      const playerClass = this.player.playing ? 'active' : 'idle'
      return `now-playing--${playerClass}`
    },

    /**
     * Get the colour palette from the album cover.
     */
    getAlbumColours() {
      /**
       * No image (rare).
       */
      if (!this.player.trackAlbum?.image) {
        return
      }

      /**
       * Run node-vibrant to get colours.
       */
      Vibrant.from(this.player.trackAlbum.image)
        .quality(1)
        .clearFilters()
        .getPalette()
        .then(palette => {
          this.handleAlbumPalette(palette)
        })
    },

    /**
     * Return a formatted empty object for an idle player.
     * @return {Object}
     */
    getEmptyPlayer() {
      return {
        playing: false,
        trackAlbum: {},
        trackArtists: [],
        trackId: '',
        trackTitle: ''
      }
    },

    /**
     * Poll Spotify for data.
     */
    setDataInterval() {
      clearInterval(this.pollPlaying)
      this.pollPlaying = setInterval(() => {
        this.getNowPlaying()
      }, 2500)
    },

    /**
     * Set the stylings of the app based on received colours.
     */
    setAppColours() {
      document.documentElement.style.setProperty(
        '--color-text-primary',
        this.colourPalette.text
      )

      document.documentElement.style.setProperty(
        '--colour-background-now-playing',
        this.colourPalette.background
      )
    },

    /**
     * Handle newly updated Spotify Tracks.
     */
    handleNowPlaying() {
      if (
        this.playerResponse.error?.status === 401 ||
        this.playerResponse.error?.status === 400
      ) {
        this.handleExpiredToken()

        return
      }

      /**
       * Nothing to show (e.g. an ad or a podcast with no track item).
       * Paused tracks are no longer cleared here: the screen keeps
       * the cover up so the play button stays reachable.
       */
      if (!this.playerResponse.item) {
        return
      }

      /**
       * The newly fetched track is the same as our stored
       * one, we don't want to update the DOM yet.
       */
      if (this.playerResponse.item.id === this.playerData.trackId) {
        return
      }

      /**
       * Store the current active track.
       * `playing` here means "there is a track to show",
       * paused or not. Play state lives in isPaused.
       */
      this.playerData = {
        playing: true,
        trackArtists: this.playerResponse.item.artists.map(
          artist => artist.name
        ),
        trackTitle: this.playerResponse.item.name,
        trackId: this.playerResponse.item.id,
        trackAlbum: {
          title: this.playerResponse.item.album.name,
          image: this.playerResponse.item.album.images[0].url
        }
      }
    },

    /**
     * Handle newly stored colour palette:
     * - Map data to readable format
     * - Get and store random colour combination.
     */
    handleAlbumPalette(palette) {
      let albumColours = Object.keys(palette)
        .filter(item => {
          return item === null ? null : item
        })
        .map(colour => {
          return {
            text: palette[colour].getTitleTextColor(),
            background: palette[colour].getHex()
          }
        })

      this.swatches = albumColours

      this.colourPalette =
        albumColours[Math.floor(Math.random() * albumColours.length)]

      this.$nextTick(() => {
        this.setAppColours()
      })
    },

    /**
     * Handle an expired access token from Spotify.
     */
    handleExpiredToken() {
      clearInterval(this.pollPlaying)
      this.$emit('requestRefreshToken')
    }
  },
  watch: {
    /**
     * Watch the auth object returned from Spotify.
     */
    auth: function(oldVal, newVal) {
      if (newVal.status === false) {
        clearInterval(this.pollPlaying)
      }
    },

    /**
     * Watch the returned track object.
     */
    playerResponse: function() {
      this.handleNowPlaying()
    },

    /**
     * Watch our locally stored track data.
     */
    playerData: function() {
      this.$emit('spotifyTrackUpdated', this.playerData)

      this.$nextTick(() => {
        this.getAlbumColours()
      })
    }
  }
}
</script>

<style src="@/styles/components/now-playing.scss" lang="scss" scoped></style>

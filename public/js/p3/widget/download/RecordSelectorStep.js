define([
  'dojo/_base/declare',
  'dojo/_base/lang',
  'dojo/on',
  'dojo/dom-class',
  'dojo/dom-construct',
  'dojo/query',
  'dojo/when',
  './WizardStepBase',
  'dojo/text!./templates/RecordSelectorStep.html',
  '../../util/DownloadFormats',
  '../../util/joinTooBroad'
], function (
  declare,
  lang,
  on,
  domClass,
  domConstruct,
  query,
  when,
  WizardStepBase,
  template,
  DownloadFormats,
  joinTooBroad
) {
  /**
   * RecordSelectorStep - Step 2: Select which records to download
   *
   * Options:
   * - Selected records (from grid selection)
   * - All records (matching current query)
   */

  return declare([WizardStepBase], {
    templateString: template,
    stepId: 'records',
    stepTitle: 'Records',
    stepDescription: 'Choose which records to include',

    // State
    selectedScope: 'all',
    selectionCount: 0,
    totalCount: null,

    // Event handlers
    _handlers: null,

    postCreate: function () {
      this.inherited(arguments);
      this._handlers = [];
      this._setupEventHandlers();
    },

    /**
     * Setup event handlers
     */
    _setupEventHandlers: function () {
      var self = this;

      // Option click handlers (only selected and all now)
      ['selectedOption', 'allOption'].forEach(function (optionName) {
        if (self[optionName]) {
          var handler = on(self[optionName], 'click', function (evt) {
            var scope = this.getAttribute('data-scope');
            self._selectScope(scope);
          });
          self._handlers.push(handler);
        }
      });
    },

    /**
     * Called when context is set
     */
    onContextSet: function (context) {
      this._updateCounts();
    },

    /**
     * Called when step becomes visible
     */
    onShow: function () {
      this.inherited(arguments);
      this._updateCounts();
      this._updateUI();
    },

    /**
     * Update record counts
     */
    _updateCounts: function () {
      var self = this;

      // Selection count - check queryDescriptor.selectedIds first, then context.selection
      this.selectionCount = 0;
      if (this.context && this.context.queryDescriptor && this.context.queryDescriptor.selectedIds) {
        this.selectionCount = this.context.queryDescriptor.selectedIds.length;
      } else if (this.context && this.context.selection) {
        this.selectionCount = this.context.selection.length;
      }

      // Update selected count display
      if (this.selectedCountNode) {
        var countSpan = this.selectedCountNode.querySelector('.countValue');
        if (countSpan) {
          countSpan.textContent = this.formatNumber(this.selectionCount);
        }
      }

      // Disable selected option if no selection, default to it when available
      if (this.selectionCount === 0) {
        if (this.selectedOption) {
          domClass.add(this.selectedOption, 'disabled');
        }
        if (this.selectedRadio) this.selectedRadio.disabled = true;
        if (this.selectedScope === 'selected') {
          this._selectScope('all');
        }
      } else {
        if (this.selectedOption) {
          domClass.remove(this.selectedOption, 'disabled');
        }
        if (this.selectedRadio) this.selectedRadio.disabled = false;
        if (this.selectedScope === 'all') {
          this._selectScope('selected');
        }
      }

      // Fetch total count (async)
      this._fetchTotalCount();
    },

    /**
     * Fetch total record count from server
     */
    _fetchTotalCount: function () {
      var self = this;

      if (!this.context || !this.context.queryDescriptor) {
        return;
      }

      // Show loading
      if (this.allCountNode) {
        var countSpan = this.allCountNode.querySelector('.countValue');
        if (countSpan) {
          countSpan.innerHTML = '<i class="icon-spinner fa-spin"></i>';
        }
      }

      // Get data type config
      var dataType = this.context.dataType;
      var config = DownloadFormats.getDataTypeConfig(dataType);

      // Build count query
      var baseUrl = window.App.dataServiceURL || '';
      if (baseUrl.charAt(baseUrl.length - 1) !== '/') {
        baseUrl += '/';
      }

      var rqlQuery = this.context.queryDescriptor.rqlQuery || '';
      var countUrl = baseUrl + dataType + '/?select(id)&limit(1)&' + rqlQuery;

      // dojo/request, NOT dojo/request/xhr: the plain module resolves through
      // p3/util/throttledRequest, so this count query gets 429/503 retry.
      // The raw transport would bypass the provider entirely.
      require(['dojo/request'], function (xhr) {
        xhr(countUrl, {
          handleAs: 'json',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
            'Authorization': window.App.authorizationToken ? window.App.authorizationToken : ''
          }
        }).response.then(
          function (response) {
            var contentRange = response.getHeader && response.getHeader('Content-Range');
            if (contentRange) {
              // Content-Range: items 0-0/12345
              var match = contentRange.match(/\/(\d+)$/);
              if (match) {
                self.totalCount = parseInt(match[1], 10);
              }
            }

            if (self.allCountNode) {
              var countSpan = self.allCountNode.querySelector('.countValue');
              if (countSpan) {
                countSpan.textContent = self.totalCount !== null
                  ? self.formatNumber(self.totalCount)
                  : 'All matching';
              }
            }
          },
          function (err) {
            // The count query uses a grid-shaped request, so a too-broad genome(...)
            // filter is refused here (400 in ~1.5s) even though the DOWNLOAD of the
            // same filter succeeds: BV-BRC-API#245 lets a bulk download resolve the
            // join in bounded slices instead of refusing it. Measured on alpha, same
            // Viruses filter: count query 400, download 200 with real CSV in ~4s.
            //
            // So this is NOT a reason to block the download. Per
            // Docs/CLIENT-join-too-broad.md: "If the UI offers 'download these
            // results' next to a too-broad grid, the download is worth offering even
            // when the grid is refused." We only lose the row count.
            if (joinTooBroad.isJoinTooBroad(err)) {
              self._noteCountUnavailable(err);
              return;
            }
            console.warn('Failed to fetch record count:', err);
            if (self.allCountNode) {
              var countSpan = self.allCountNode.querySelector('.countValue');
              if (countSpan) {
                countSpan.textContent = 'All matching';
              }
            }
          }
        );
      });
    },

    /**
     * Select a scope option
     */
    _selectScope: function (scope) {
      // Don't allow selecting disabled options
      if (scope === 'selected' && this.selectionCount === 0) {
        return;
      }

      this.selectedScope = scope;

      // Update radio buttons
      if (this.selectedRadio) this.selectedRadio.checked = (scope === 'selected');
      if (this.allRadio) this.allRadio.checked = (scope === 'all');

      // Update visual selection
      if (this.optionsNode) {
        query('.recordOption', this.optionsNode).forEach(function (node) {
          domClass.remove(node, 'selected');
        });

        var selectedNode = query('.recordOption[data-scope="' + scope + '"]', this.optionsNode)[0];
        if (selectedNode) {
          domClass.add(selectedNode, 'selected');
        }
      }

      // Clear error
      this.clearError();

      // Notify wizard
      this.notifyDataChanged();
    },

    /**
     * Update UI state
     */
    _updateUI: function () {
      // Ensure correct option is visually selected
      if (this.optionsNode) {
        query('.recordOption', this.optionsNode).forEach(function (node) {
          domClass.remove(node, 'selected');
        });

        var selectedNode = query('.recordOption[data-scope="' + this.selectedScope + '"]', this.optionsNode)[0];
        if (selectedNode) {
          domClass.add(selectedNode, 'selected');
        }
      }
    },

    /**
     * Validate the step
     */
    /**
     * The count query was refused as too broad. Note it and move on.
     *
     * Deliberately does NOT block the download or offer the taxon drill-down the
     * grid shows. The download path resolves this join in slices (BV-BRC-API#245)
     * and completes, so refusing it here would deny the user a download the server
     * is willing to produce -- the exact case the API contract calls out.
     *
     * What is genuinely lost is the count: `numFound` is never computed for a
     * batched join, so we cannot say how many records this will be.
     */
    _noteCountUnavailable: function (err) {
      this._joinTooBroadInfo = joinTooBroad.parse(err);

      if (this.allCountNode) {
        var countSpan = this.allCountNode.querySelector('.countValue');
        if (countSpan) {
          countSpan.textContent = 'All matching';
        }
      }

      if (!this.countNoteNode) { return; }
      domConstruct.empty(this.countNoteNode);
      domClass.remove(this.countNoteNode, 'dijitHidden');
      // Plain text node: the count and limit come from the API.
      this.countNoteNode.appendChild(document.createTextNode(
        'This selection is too large to count up front'
        + (this._joinTooBroadInfo && this._joinTooBroadInfo.genomeCount
          ? ' (' + joinTooBroad.formatCount(this._joinTooBroadInfo.genomeCount) + ' genomes)'
          : '')
        + '. The download will still run, but may take several minutes.'
      ));
    },

    validate: function () {
      if (this.selectedScope === 'selected' && this.selectionCount === 0) {
        return {
          valid: false,
          message: 'No records are selected. Please select records or choose "All records".'
        };
      }

      // NOTE: a too-broad genome(...) filter is deliberately NOT blocked here.
      // The count query is refused but the download is not -- see
      // _noteCountUnavailable and BV-BRC-API#245.

      return true;
    },

    /**
     * Get step data
     */
    getData: function () {
      return {
        scope: this.selectedScope,
        selectionCount: this.selectionCount,
        totalCount: this.totalCount
      };
    },

    /**
     * Reset the step
     */
    reset: function () {
      this.inherited(arguments);
      this.selectedScope = 'all';
      this._selectScope('all');
    },

    /**
     * Check if step can be skipped (single record scenarios)
     */
    canSkip: function () {
      // Skip if there's only one record
      return this.selectionCount === 1 && this.totalCount === 1;
    },

    /**
     * Destroy
     */
    destroy: function () {
      this._handlers.forEach(function (h) {
        h.remove();
      });
      this._handlers = [];
      this.inherited(arguments);
    }
  });
});

const express = require("express");

const {
  Report,
  Division,
  Office,
  DashboardWorksheet,
  ChatbotConversation,
} = require("../models/index");

const {
  loadDivisionData,
} = require("./googleSheetsService");

const {
  answerQuestion,
} = require("../chatbotEngine/chatbotService");

const {
  getConversation,
  clearConversation,
} = require("../chatbotEngine/conversationManager");

const router = express.Router();

/**
 * ============================================================
 * GOOGLE SHEETS HELPERS
 * ============================================================
 */

/**
 * Extract the Google Spreadsheet ID from the URL stored
 * in reports.sheetUrl.
 *
 * Example:
 * https://docs.google.com/spreadsheets/d/ABC123/edit?usp=sharing
 *
 * Returns:
 * ABC123
 */
function getGoogleSpreadsheetId(sheetUrl) {
  if (!sheetUrl || typeof sheetUrl !== "string") {
    throw new Error(
      "No Google Sheets URL is configured for this report."
    );
  }

  const trimmedUrl = sheetUrl.trim();

  if (!trimmedUrl.startsWith("https://")) {
    throw new Error(
      "The configured Google Sheets URL is invalid."
    );
  }

  const match = trimmedUrl.match(
    /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/
  );

  if (!match) {
    throw new Error(
      "The configured link is not a valid Google Sheets URL."
    );
  }

  return match[1];
}

/**
 * Build the CSV URL for ONE worksheet.
 *
 * The Google Sheet URL itself comes from:
 *
 * reports.sheetUrl
 *
 * The worksheet GID comes from:
 *
 * dashboard_worksheets.gid
 */
function buildWorksheetCsvUrl(sheetUrl, gid) {
  const spreadsheetId =
    getGoogleSpreadsheetId(sheetUrl);

  const worksheetGid = String(
    gid ?? ""
  ).trim();

  if (!worksheetGid) {
    throw new Error(
      "A worksheet does not have a configured GID."
    );
  }

  return (
    `https://docs.google.com/spreadsheets/d/` +
    `${spreadsheetId}/export?format=csv&gid=` +
    `${encodeURIComponent(worksheetGid)}`
  );
}

/**
 * ============================================================
 * REPORT DATASET
 * ============================================================
 *
 * Loads:
 *
 * reports
 *      +
 * dashboard_worksheets
 *
 * reports.id
 *      ↓
 * dashboard_worksheets.dashboardId
 */
async function getReportDataset(reportId) {
  const numericReportId = Number(reportId);

  if (!Number.isInteger(numericReportId)) {
    const error = new Error(
      "A valid report ID is required."
    );

    error.statusCode = 400;
    throw error;
  }

  /**
   * Get the dashboard/report.
   */
  const report = await Report.findByPk(
    numericReportId,
    {
      include: [
        {
          model: Division,
          as: "division",
          include: [
            {
              model: Office,
              as: "office",
            },
          ],
        },
      ],
    }
  );

  if (!report) {
    const error = new Error(
      "Report not found."
    );

    error.statusCode = 404;
    throw error;
  }

  /**
   * Google Spreadsheet URL is still stored
   * in the reports table.
   */
  if (!report.sheetUrl) {
    const error = new Error(
      `No Google Sheet is configured for "${report.title}".`
    );

    error.statusCode = 400;
    throw error;
  }

  /**
   * Get ALL worksheet tabs belonging to this dashboard.
   *
   * dashboard_worksheets.dashboardId
   * points to:
   *
   * reports.id
   */
  const worksheets =
    await DashboardWorksheet.findAll({
      where: {
        dashboardId: numericReportId,
      },

      order: [
        ["worksheetId", "ASC"],
      ],
    });

  if (!worksheets.length) {
    const error = new Error(
      `No worksheets are configured for "${report.title}".`
    );

    error.statusCode = 400;
    throw error;
  }

  /**
   * Build the configuration expected by
   * googleSheetsService.js.
   *
   * Example:
   *
   * {
   *   name: "CSM Analytics Dashboard 2025",
   *   sheets: [
   *      {
   *         name: "FIRST",
   *         csvUrl: "...gid=0"
   *      },
   *      {
   *         name: "Second",
   *         csvUrl: "...gid=123456"
   *      }
   *   ]
   * }
   */
  const reportConfig = {
    name: report.title,

    sheets: worksheets.map(
      (worksheet) => ({
        name:
          worksheet.worksheetName,

        csvUrl:
          buildWorksheetCsvUrl(
            report.sheetUrl,
            worksheet.gid
          ),
      })
    ),
  };

  return {
    report,
    worksheets,
    reportConfig,
  };
}

/**
 * ============================================================
 * GET DIVISIONS
 * ============================================================
 *
 * GET /api/chatbot/divisions
 */
router.get("/divisions", async (req, res) => {
  try {
    const offices = await Office.findAll({
      order: [["name", "ASC"]],
    });

    return res.json({
      success: true,

      divisions: offices.map(
        (office) => ({
          id: Number(office.id),

          code:
            office.acronym || "",

          acronym:
            office.acronym || "",

          name:
            office.name,
        })
      ),
    });
  } catch (error) {
    console.error(
      "Unable to load chatbot divisions:",
      error
    );

    return res.status(500).json({
      success: false,

      message:
        error.message ||
        "Unable to load divisions.",
    });
  }
});

/**
 * ============================================================
 * GET OFFICES / SECTIONS
 * ============================================================
 *
 * GET /api/chatbot/offices?divisionId=1
 */
router.get("/offices", async (req, res) => {
  try {
    const divisionId = Number(
      req.query.divisionId
    );

    if (!Number.isInteger(divisionId)) {
      return res.status(400).json({
        success: false,

        message:
          "A valid division ID is required.",
      });
    }

    const parentOffice =
      await Office.findByPk(
        divisionId
      );

    if (!parentOffice) {
      return res.status(404).json({
        success: false,

        message:
          "The selected division was not found.",
      });
    }

    const sections =
      await Division.findAll({
        where: {
          officeId: divisionId,
        },

        order: [["name", "ASC"]],
      });

    return res.json({
      success: true,

      division: {
        id: Number(
          parentOffice.id
        ),

        code:
          parentOffice.acronym || "",

        acronym:
          parentOffice.acronym || "",

        name:
          parentOffice.name,
      },

      offices: sections.map(
        (section) => ({
          id: Number(
            section.id
          ),

          code:
            section.acronym || "",

          acronym:
            section.acronym || "",

          name:
            section.name,

          divisionId: Number(
            section.officeId
          ),
        })
      ),
    });
  } catch (error) {
    console.error(
      "Unable to load chatbot offices:",
      error
    );

    return res.status(500).json({
      success: false,

      message:
        error.message ||
        "Unable to load offices.",
    });
  }
});

/**
 * ============================================================
 * GET REPORTS
 * ============================================================
 *
 * GET /api/chatbot/reports?officeId=8
 */
router.get("/reports", async (req, res) => {
  try {
    const officeId = Number(
      req.query.officeId
    );

    if (!Number.isInteger(officeId)) {
      return res.status(400).json({
        success: false,

        message:
          "A valid office ID is required.",
      });
    }

    const selectedDivision =
      await Division.findByPk(
        officeId
      );

    if (!selectedDivision) {
      return res.status(404).json({
        success: false,

        message:
          "The selected office or section was not found.",
      });
    }

    /**
     * Include the worksheets so the frontend can know
     * whether this dashboard actually has chatbot data.
     */
    const reports =
      await Report.findAll({
        where: {
          divisionId: officeId,
        },

        include: [
          {
            model:
              DashboardWorksheet,

            as: "worksheets",

            required: false,

            attributes: [
              "worksheetId",
              "worksheetName",
              "gid",
            ],
          },
        ],

        order: [["title", "ASC"]],
      });

    return res.json({
      success: true,

      office: {
        id: Number(
          selectedDivision.id
        ),

        code:
          selectedDivision.acronym ||
          "",

        acronym:
          selectedDivision.acronym ||
          "",

        name:
          selectedDivision.name,

        divisionId: Number(
          selectedDivision.officeId
        ),
      },

      reports: reports.map(
        (report) => ({
          id: Number(
            report.id
          ),

          title:
            report.title,

          description:
            report.description || "",

          /**
           * hasSheet is TRUE only when:
           *
           * 1. reports.sheetUrl exists
           * 2. at least one worksheet is configured
           */
          hasSheet:
            Boolean(report.sheetUrl) &&
            Array.isArray(
              report.worksheets
            ) &&
            report.worksheets.length >
              0,

          worksheetCount:
            Array.isArray(
              report.worksheets
            )
              ? report.worksheets
                  .length
              : 0,

          worksheets:
            Array.isArray(
              report.worksheets
            )
              ? report.worksheets.map(
                  (worksheet) => ({
                    id: Number(
                      worksheet.worksheetId
                    ),

                    name:
                      worksheet.worksheetName,

                    gid:
                      worksheet.gid,
                  })
                )
              : [],
        })
      ),
    });
  } catch (error) {
    console.error(
      "Unable to load chatbot reports:",
      error
    );

    return res.status(500).json({
      success: false,

      message:
        error.message ||
        "Unable to load reports.",
    });
  }
});

/**
 * ============================================================
 * INSPECT REPORT DATA
 * ============================================================
 *
 * GET /api/chatbot/reports/:reportId/inspect
 *
 * This now loads ALL worksheets configured in:
 *
 * dashboard_worksheets
 */
router.get(
  "/reports/:reportId/inspect",
  async (req, res) => {
    try {
      const {
        report,
        reportConfig,
      } =
        await getReportDataset(
          req.params.reportId
        );

      /**
       * googleSheetsService.js already knows how
       * to loop through reportConfig.sheets.
       *
       * Therefore ALL configured worksheets
       * are downloaded here.
       */
      const reportData =
        await loadDivisionData(
          reportConfig
        );

      const worksheets =
        Object.entries(
          reportData
        ).map(
          ([
            worksheetName,
            sheetData,
          ]) => {
            let rows = [];
            let error = null;

            if (
              Array.isArray(
                sheetData
              )
            ) {
              rows =
                sheetData;
            } else {
              rows =
                sheetData?.rows ||
                [];

              error =
                sheetData?.error ||
                null;
            }

            const columnNames =
              new Set();

            /**
             * Inspect up to 20 rows to discover
             * the worksheet columns.
             */
            for (
              const row of rows.slice(
                0,
                20
              )
            ) {
              Object.keys(
                row
              ).forEach(
                (columnName) => {
                  columnNames.add(
                    columnName
                  );
                }
              );
            }

            return {
              worksheetName,

              rowCount:
                rows.length,

              columns:
                Array.from(
                  columnNames
                ),

              error,
            };
          }
        );

      return res.json({
        success: true,

        report: {
          id: Number(
            report.id
          ),

          title:
            report.title,

          divisionId: Number(
            report.divisionId
          ),

          office:
            report.division
              ?.name || null,

          division:
            report.division
              ?.office?.name ||
            null,
        },

        worksheetCount:
          worksheets.length,

        worksheets,
      });
    } catch (error) {
      console.error(
        "Chatbot inspection error:",
        error
      );

      return res
        .status(
          error.statusCode ||
            500
        )
        .json({
          success: false,

          message:
            error.message ||
            "Unable to inspect the Google Sheet.",
        });
    }
  }
);

/**
 * ============================================================
 * PERSISTENT CHATBOT CONVERSATION STATE
 * ============================================================
 *
 * The chatbot engine may still use its fast in-memory Map during
 * one request, but PostgreSQL is the source of truth between
 * requests/containers.
 */

function getConversationTtlHours() {
  const configured =
    Number(
      process.env
        .CHATBOT_SESSION_TTL_HOURS
    );

  return (
    Number.isFinite(
      configured
    ) &&
    configured > 0
  )
    ? configured
    : 24;
}


function buildConversationKey(
  sessionId,
  reportId
) {
  return (
    `${String(sessionId).trim()}` +
    `::report:${Number(reportId)}`
  );
}


function cloneSerializableState(
  value
) {
  return JSON.parse(
    JSON.stringify(
      value || {}
    )
  );
}


async function hydrateConversationState({
  sessionId,
  reportId,
}) {
  const conversationKey =
    buildConversationKey(
      sessionId,
      reportId
    );

  const stored =
    await ChatbotConversation.findOne({
      where: {
        sessionKey:
          conversationKey,
      },
    });

  if (
    stored?.expiresAt &&
    new Date(
      stored.expiresAt
    ).getTime() <=
      Date.now()
  ) {
    await stored.destroy();

    clearConversation(
      conversationKey
    );

    return {
      conversationKey,
      restored:
        false,
    };
  }

  if (
    stored?.state &&
    typeof stored.state ===
      "object"
  ) {
    const context =
      getConversation(
        conversationKey
      );

    /**
     * Replace the process-local copy with the persisted state.
     * This prevents stale context from another request from winning.
     */
    for (
      const key of
      Object.keys(context)
    ) {
      delete context[key];
    }

    Object.assign(
      context,
      cloneSerializableState(
        stored.state
      )
    );

    return {
      conversationKey,
      restored:
        true,
    };
  }

  return {
    conversationKey,
    restored:
      false,
  };
}


async function persistConversationState({
  sessionId,
  reportId,
  conversationKey,
}) {
  const context =
    getConversation(
      conversationKey
    );

  const ttlHours =
    getConversationTtlHours();

  const expiresAt =
    new Date(
      Date.now() +
      ttlHours *
        60 *
        60 *
        1000
    );

  const state =
    cloneSerializableState(
      context
    );

  await ChatbotConversation.upsert({
    sessionKey:
      conversationKey,

    sessionId:
      String(
        sessionId
      ).trim(),

    reportId:
      Number(
        reportId
      ),

    state,

    expiresAt,
  });
}


// ============================================================
// CHAT
// ============================================================
//
// POST /api/chatbot/chat
//
// {
//   "reportId": 1,
//   "question": "What is the total expected yield?",
//   "sessionId": "abc123"
// }
// ============================================================

router.post("/chat-test", async (req, res) => {
  try {
    return res.json({
      success: true,
      ollamaKeyExists: Boolean(process.env.OLLAMA_API_KEY),
      ollamaModel: process.env.OLLAMA_MODEL || "gemma4:31b"
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.post("/chat", async (req, res) => {

  console.log(
    "============================================================"
  );

  console.log(
    "CHATBOT REQUEST STARTED"
  );

  console.log(
    "Request report ID:",
    req.body?.reportId
  );

  console.log(
    "OLLAMA_API_KEY available:",
    Boolean(process.env.OLLAMA_API_KEY)
  );

  console.log(
    "OLLAMA_MODEL:",
    process.env.OLLAMA_MODEL || "gemma4:31b"
  );

  console.log(
    "============================================================"
  );


  try {

    // ========================================================
    // READ REQUEST
    // ========================================================

    const question = String(
      req.body?.question || ""
    ).trim();


    const reportId = Number(
      req.body?.reportId
    );


    const sessionId = String(
      req.body?.sessionId || ""
    ).trim();


    console.log(
      "Parsed request:",
      {
        reportId,
        question,
        sessionId
      }
    );


    // ========================================================
    // VALIDATION
    // ========================================================

    if (!question) {

      return res.status(400).json({
        success: false,
        message: "Question is required."
      });

    }


    if (!Number.isInteger(reportId)) {

      return res.status(400).json({
        success: false,
        message: "A valid report ID is required."
      });

    }


    if (!sessionId) {

      return res.status(400).json({
        success: false,
        message: "A chatbot session ID is required."
      });

    }


    // ========================================================
    // LOAD REPORT CONFIGURATION
    // ========================================================

    console.log(
      "STEP 1: Loading report dataset..."
    );


    const {
      report,
      worksheets,
      reportConfig
    } = await getReportDataset(
      reportId
    );


    console.log(
      "STEP 1 SUCCESS"
    );


    console.log(
      "Report:",
      {
        id: report?.id,
        title: report?.title,
        sheetUrlExists:
          Boolean(report?.sheetUrl)
      }
    );


    console.log(
      "Configured worksheets:",
      worksheets?.map(
        worksheet => ({
          id:
            worksheet.worksheetId,

          name:
            worksheet.worksheetName,

          gid:
            worksheet.gid
        })
      )
    );


    console.log(
      "Report config:",
      reportConfig
    );


    // ========================================================
    // LOAD GOOGLE SHEETS
    // ========================================================

    console.log(
      "STEP 2: Loading Google Sheets..."
    );


    const reportData =
      await loadDivisionData(
        reportConfig
      );


    console.log(
      "STEP 2 SUCCESS"
    );


    if (
      !reportData ||
      typeof reportData !== "object"
    ) {

      return res.status(500).json({
        success: false,
        message:
          "Google Sheets service returned invalid data."
      });

    }


    const availableSheets =
      Object.keys(
        reportData
      );


    console.log(
      "Available sheets:",
      availableSheets
    );


    if (
      availableSheets.length === 0
    ) {

      return res.status(500).json({
        success: false,

        message:
          "The selected report did not return any Google Sheets data."
      });

    }


    // ========================================================
    // COUNT ROWS
    // ========================================================

    let totalRows = 0;


    for (
      const sheetName
      of availableSheets
    ) {

      const sheet =
        reportData[
          sheetName
        ];


      if (
        Array.isArray(sheet)
      ) {

        totalRows +=
          sheet.length;

      } else if (
        Array.isArray(
          sheet?.rows
        )
      ) {

        totalRows +=
          sheet.rows.length;

      }

    }


    console.log(
      "Total readable rows:",
      totalRows
    );


    if (
      totalRows === 0
    ) {

      return res.status(400).json({
        success: false,

        message:
          "The connected Google Sheets contain no readable rows."
      });

    }


    // ========================================================
    // ASK CHATBOT ENGINE
    // ========================================================

    console.log(
      "STEP 3: Calling chatbot engine..."
    );


    /**
     * Restore chatbot memory from PostgreSQL before answering.
     *
     * The internal conversation key also includes reportId so one
     * dashboard's follow-up context cannot leak into another dashboard.
     */
    const {
      conversationKey,
      restored:
        conversationRestored,
    } =
      await hydrateConversationState({
        sessionId,
        reportId,
      });

    console.log(
      "Conversation state restored:",
      conversationRestored
    );

    const result =
      await answerQuestion(
        reportData,
        question,
        conversationKey
      );

    /**
     * Save VERIFIED post-execution conversation state.
     */
    await persistConversationState({
      sessionId,
      reportId,
      conversationKey,
    });


    console.log(
      "STEP 3 SUCCESS"
    );


    console.log(
      "Chatbot result type:",
      typeof result
    );


    // ========================================================
    // RESPONSE
    // ========================================================

    const responsePayload = {

      success:
        typeof result?.success ===
        "boolean"
          ? result.success
          : true,


      ...(result &&
      typeof result === "object"
        ? result
        : {
            answer:
              String(
                result || ""
              )
          }),


      question,

      sessionId,


      report: {

        id:
          Number(
            report.id
          ),

        title:
          report.title,

        divisionId:
          Number(
            report.divisionId
          ),

        office:
          report.division
            ?.name ||
          null,

        division:
          report.division
            ?.office
            ?.name ||
          null

      },


      worksheetCount:
        availableSheets.length,


      worksheets:
        availableSheets,


      totalRows

    };


    console.log(
      "CHATBOT REQUEST SUCCESS"
    );


    return res.json(
      responsePayload
    );

  } catch (error) {

    console.error(
      "============================================================"
    );

    console.error(
      "CHATBOT REQUEST FAILED"
    );

    console.error(
      "Error name:",
      error?.name
    );

    console.error(
      "Error message:",
      error?.message
    );

    console.error(
      "Error stack:",
      error?.stack
    );


    if (
      error?.response
    ) {

      console.error(
        "External response status:",
        error.response.status
      );

      console.error(
        "External response data:",
        error.response.data
      );

    }


    console.error(
      "============================================================"
    );


    // Always use a valid HTTP status.
    const requestedStatus =
      Number(
        error?.statusCode
      );


    const statusCode =
      Number.isInteger(
        requestedStatus
      ) &&
      requestedStatus >= 400 &&
      requestedStatus <= 599
        ? requestedStatus
        : 500;


    try {

      return res
        .status(
          statusCode
        )
        .json({
          success: false,

          message:
            error?.message ||
            "The chatbot was unable to answer the question.",

          stage:
            "chatbot-request"
        });

    } catch (
      responseError
    ) {

      console.error(
        "FAILED TO SEND CHATBOT ERROR RESPONSE:",
        responseError
      );


      return res.end(
        JSON.stringify({
          success: false,
          message:
            "Internal chatbot error."
        })
      );

    }

  }

});

module.exports = router;
module.exports.default = router;

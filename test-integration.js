import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test function to call the Python emoji recommendation script
async function testEmojiRecommendation() {
  try {
    console.log("Testing Python emoji recommendation integration...");

    // Create a test CSV file
    const testCsvPath = path.join(__dirname, "test_table.csv");
    const testJsonPath = path.join(__dirname, "test_recommendations.json");

    // Sample movie data - description row must have n-1 commas where n is the number of columns
    const csvContent = [
      "Movie ratings by genre,,",
      "Genre,Rating,Year",
      "Action,8.5,2020",
      "Comedy,7.8,2021",
      "Drama,8.9,2019",
    ].join("\n");

    await fs.writeFile(testCsvPath, csvContent);
    console.log("Created test CSV file:", testCsvPath);

    // Call the Python script
    const pythonModulePath = path.join(
      __dirname,
      "..",
      "emoji-recommendation",
      "src"
    );

    // Check if virtual environment exists
    const venvPythonPath = path.join(
      __dirname,
      "..",
      "emoji-recommendation",
      ".venv",
      "bin",
      "python"
    );

    try {
      await fs.access(venvPythonPath);
    } catch (error) {
      throw new Error(
        `Virtual environment not found at ${venvPythonPath}. Please run:\n` +
          `cd ../emoji-recommendation\n` +
          `python3 -m venv .venv\n` +
          `source .venv/bin/activate\n` +
          `pip install -r requirements.txt`
      );
    }

    return new Promise((resolve, reject) => {
      // Use Python from the virtual environment

      const pythonProcess = spawn(
        venvPythonPath,
        [
          "-m",
          "emoji_data.generate_emojis",
          "--input_csv",
          testCsvPath,
          "--output_json",
          testJsonPath,
          "--top_k",
          "5",
        ],
        {
          cwd: pythonModulePath,
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      let stdout = "";
      let stderr = "";

      pythonProcess.stdout.on("data", (data) => {
        stdout += data.toString();
        console.log("Python stdout:", data.toString());
      });

      pythonProcess.stderr.on("data", (data) => {
        stderr += data.toString();
        console.log("Python stderr:", data.toString());
      });

      pythonProcess.on("close", async (code) => {
        try {
          if (code === 0) {
            console.log("Python script completed successfully!");

            // Read the generated JSON file
            const jsonContent = await fs.readFile(testJsonPath, "utf8");
            const recommendations = JSON.parse(jsonContent);

            console.log("\n=== EMOJI RECOMMENDATIONS ===");
            console.log(
              "Table description:",
              recommendations.table_description
            );
            console.log("\nColumn name emojis:");
            Object.entries(recommendations.column_name_emojis).forEach(
              ([col, emojis]) => {
                console.log(`  ${col}: ${emojis.join(" ")}`);
              }
            );

            if (recommendations.categorical_value_emojis) {
              console.log("\nCategorical value emojis:");
              Object.entries(recommendations.categorical_value_emojis).forEach(
                ([col, values]) => {
                  console.log(`  ${col}:`);
                  Object.entries(values).forEach(([val, emojis]) => {
                    console.log(`    ${val}: ${emojis.join(" ")}`);
                  });
                }
              );
            }

            if (recommendations.column_emoji_scales) {
              console.log("\nColumn emoji scales:");
              Object.entries(recommendations.column_emoji_scales).forEach(
                ([col, scale]) => {
                  console.log(`  ${col}:`, scale);
                }
              );
            }

            // Clean up temporary files
            await fs.unlink(testCsvPath);
            await fs.unlink(testJsonPath);
            console.log("\nCleaned up temporary files");

            resolve(recommendations);
          } else {
            console.error("Python script failed with code:", code);
            console.error("Error output:", stderr);
            reject(
              new Error(`Python script failed with code ${code}: ${stderr}`)
            );
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  } catch (error) {
    console.error("Error testing emoji recommendation:", error);
    throw error;
  }
}

// Run the test
testEmojiRecommendation()
  .then(() => {
    console.log("\n✅ Integration test completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Integration test failed:", error.message);
    process.exit(1);
  });

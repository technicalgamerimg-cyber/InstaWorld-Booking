/*
  Warnings:

  - You are about to drop the column `shipperAddress` on the `Settings` table. All the data in the column will be lost.
  - You are about to drop the column `shipperCity` on the `Settings` table. All the data in the column will be lost.
  - You are about to drop the column `shipperName` on the `Settings` table. All the data in the column will be lost.
  - You are about to drop the column `shipperPhone` on the `Settings` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Settings" DROP COLUMN "shipperAddress",
DROP COLUMN "shipperCity",
DROP COLUMN "shipperName",
DROP COLUMN "shipperPhone";
